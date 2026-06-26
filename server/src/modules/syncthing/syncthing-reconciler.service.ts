import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { copyFile, link, mkdir, readdir, rm, stat } from 'fs/promises';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { basename, dirname, extname, join, relative, resolve } from 'path';

import {
  DEFAULT_SYNC_LAYOUT,
  resolveUploadPath,
  SYNC_LAYOUT_PATTERNS,
  type SyncLayout,
  type SyncStorageMode,
  type SyncTarget,
} from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { authors, bookAuthors, bookFiles, bookMetadata, books, collectionBooks, syncTargetCollections, syncTargets } from '../../db/schema';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { formatSeriesIndex } from '../../common/utils/series-index-format.utils';
import { SyncthingClientService } from './syncthing-client.service';

type Db = NodePgDatabase<typeof schema>;

interface BookFile {
  bookId: number;
  absolutePath: string;
  format: string | null;
}

interface PatternMeta {
  bookId: number;
  title: string | null;
  seriesName: string | null;
  seriesIndex: number | null;
  publishedYear: number | null;
  authors: string[];
}

type ReconcileTarget = Pick<SyncTarget, 'id' | 'syncthingFolderId' | 'exportPath' | 'layout' | 'storageMode'>;

@Injectable()
export class SyncthingReconcilerService {
  private readonly logger = new Logger(SyncthingReconcilerService.name);
  private readonly reconcileInFlight = new Set<number>();
  private readonly reconcilePending = new Map<number, ReconcileTarget>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly syncthing: SyncthingClientService,
  ) {}

  async reconcile(target: ReconcileTarget): Promise<void> {
    const event = 'sync.reconcile';

    if (this.reconcileInFlight.has(target.id)) {
      // Coalesce: a change landed mid-reconcile. Remember the latest request and
      // re-run once the current pass finishes, so the change isn't lost until the
      // next periodic sweep. Repeated requests collapse into a single rerun.
      this.reconcilePending.set(target.id, target);
      this.logger.log(`[${event}] [coalesce] targetId=${target.id} reason=already-in-flight`);
      return;
    }

    this.reconcileInFlight.add(target.id);
    this.logger.log(`[${event}] [start] targetId=${target.id} layout=${target.layout}`);
    await this.updateStatus(target.id, 'reconciling');

    try {
      try {
        const files = await this.resolveTargetFiles(target.id);
        const metaByBookId = await this.resolvePatternMetadata(files.map((f) => f.bookId));
        const desired = this.buildRelativePaths(files, metaByBookId, target.layout);

        await mkdir(target.exportPath, { recursive: true });

        const existing = await this.scanExportDir(target.exportPath);
        const desiredPaths = new Set(desired.values());
        const existingPaths = new Set(existing);

        let linked = 0;
        let copied = 0;
        let refreshed = 0;
        let pruned = 0;

        for (const [file, relPath] of desired) {
          const destPath = this.safeJoin(target.exportPath, relPath);
          if (!destPath) continue;

          if (existingPaths.has(relPath)) {
            try {
              const [srcStat, destStat] = await Promise.all([stat(file.absolutePath).catch(() => null), stat(destPath).catch(() => null)]);
              if (!this.isStale(srcStat, destStat)) {
                // Already up to date. Classify what is actually on disk (hardlink
                // iff src and dest share a device + inode) so the reported mode
                // reflects every retained file, not just the ones we (re)write this
                // run. Without this, a target whose books already exist as copies
                // would be mislabeled "hardlink" the moment a single same-mount
                // file (e.g. from the book-dock) happens to link successfully.
                if (srcStat && destStat) {
                  if (srcStat.dev === destStat.dev && srcStat.ino === destStat.ino) linked++;
                  else copied++;
                }
                continue;
              }
              await rm(destPath, { force: true });
            } catch (err) {
              const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
              this.logger.warn(`[${event}] [file_skip] targetId=${target.id} src="${sanitizeLogValue(file.absolutePath)}" error="${msg}"`);
              continue;
            }
            refreshed++;
          }

          await mkdir(dirname(destPath), { recursive: true });
          try {
            const result = await this.linkOrCopy(file.absolutePath, destPath);
            if (result === 'link') linked++;
            else copied++;
          } catch (err) {
            const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
            this.logger.warn(`[${event}] [file_skip] targetId=${target.id} src="${sanitizeLogValue(file.absolutePath)}" error="${msg}"`);
          }
        }

        for (const relPath of existing) {
          if (!desiredPaths.has(relPath)) {
            const destPath = this.safeJoin(target.exportPath, relPath);
            if (destPath) {
              await rm(destPath, { force: true });
              pruned++;
            }
          }
        }

        await this.pruneEmptyDirs(target.exportPath);
        // Derive the mode from the actual on-disk state of every file this target
        // should contain: `linked`/`copied` count both the files (re)materialized
        // this run and the pre-existing files classified by inode above. A library
        // that partly shares the export's mount (hardlinkable) and partly does not
        // (forced to copy) reports `mixed`. `undefined` — nothing to classify, e.g.
        // an empty target — keeps the prior DB value unchanged.
        let storageMode: SyncStorageMode | undefined;
        if (linked > 0 || copied > 0) {
          storageMode = linked > 0 && copied > 0 ? 'mixed' : linked > 0 ? 'hardlink' : 'copy';
        }
        await this.syncthing.rescan(target.syncthingFolderId);
        await this.updateStatus(target.id, 'idle', { lastSyncedAt: new Date(), clearError: true, storageMode });

        this.logger.log(
          `[${event}] [end] targetId=${target.id} linked=${linked} copied=${copied} refreshed=${refreshed} pruned=${pruned}${storageMode ? ` storageMode=${storageMode}` : ''}`,
        );
      } catch (err) {
        const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
        this.logger.error(`[${event}] [fail] targetId=${target.id} error="${errorMessage}"`);
        await this.updateStatus(target.id, 'error', { lastError: errorMessage });
        throw err;
      }
    } finally {
      this.reconcileInFlight.delete(target.id);
      const pending = this.reconcilePending.get(target.id);
      if (pending) {
        this.reconcilePending.delete(target.id);
        // The rerun logs and records its own failures; swallow here so it never
        // masks the result of the pass that just completed.
        await this.reconcile(pending).catch(() => {});
      }
    }
  }

  buildRelativePaths(files: BookFile[], metaByBookId: Map<number, PatternMeta>, layout: SyncLayout = DEFAULT_SYNC_LAYOUT): Map<BookFile, string> {
    const pattern = SYNC_LAYOUT_PATTERNS[layout] ?? SYNC_LAYOUT_PATTERNS[DEFAULT_SYNC_LAYOUT];
    const used = new Map<string, BookFile>();
    const result = new Map<BookFile, string>();

    for (const file of files) {
      const relPath = this.resolveRelPath(file, metaByBookId.get(file.bookId), pattern);
      const candidate = this.deduplicatePath(relPath, used);
      used.set(candidate.toLowerCase(), file);
      result.set(file, candidate);
    }
    return result;
  }

  private async resolveTargetFiles(targetId: number): Promise<BookFile[]> {
    return this.db
      .selectDistinct({
        bookId: books.id,
        absolutePath: bookFiles.absolutePath,
        format: bookFiles.format,
      })
      .from(syncTargetCollections)
      .innerJoin(collectionBooks, eq(collectionBooks.collectionId, syncTargetCollections.collectionId))
      .innerJoin(books, eq(books.id, collectionBooks.bookId))
      .innerJoin(bookFiles, eq(bookFiles.id, books.primaryFileId))
      .where(eq(syncTargetCollections.syncTargetId, targetId));
  }

  private async resolvePatternMetadata(bookIds: number[]): Promise<Map<number, PatternMeta>> {
    if (bookIds.length === 0) return new Map();

    const [metaRows, authorRows] = await Promise.all([
      this.db
        .select({
          bookId: books.id,
          title: bookMetadata.title,
          seriesName: bookMetadata.seriesName,
          seriesIndex: bookMetadata.seriesIndex,
          publishedYear: bookMetadata.publishedYear,
        })
        .from(books)
        .leftJoin(bookMetadata, eq(bookMetadata.bookId, books.id))
        .where(inArray(books.id, bookIds)),
      this.db
        .select({ bookId: bookAuthors.bookId, name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(inArray(bookAuthors.bookId, bookIds))
        .orderBy(asc(bookAuthors.displayOrder)),
    ]);

    const authorsByBookId = new Map<number, string[]>();
    for (const row of authorRows) {
      const list = authorsByBookId.get(row.bookId) ?? [];
      list.push(row.name);
      authorsByBookId.set(row.bookId, list);
    }

    const result = new Map<number, PatternMeta>();
    for (const row of metaRows) {
      result.set(row.bookId, {
        bookId: row.bookId,
        title: row.title,
        seriesName: row.seriesName,
        seriesIndex: row.seriesIndex,
        publishedYear: row.publishedYear,
        authors: authorsByBookId.get(row.bookId) ?? [],
      });
    }
    return result;
  }

  private resolveRelPath(file: BookFile, meta: PatternMeta | undefined, pattern: string): string {
    const pathExt = extname(file.absolutePath).toLowerCase().slice(1);
    const ext = pathExt || (file.format && file.format !== 'unknown' ? file.format : 'bin');
    const stem = basename(file.absolutePath, extname(file.absolutePath));
    const tokens: Record<string, string> = { originalFilename: stem, extension: ext };

    if (meta) {
      if (meta.title) tokens['title'] = meta.title;
      if (meta.seriesName) tokens['series'] = meta.seriesName;
      if (meta.publishedYear) tokens['year'] = String(meta.publishedYear);
      const seriesIndex = formatSeriesIndex(meta.seriesIndex ?? null);
      if (seriesIndex) tokens['seriesIndex'] = seriesIndex;
      if (meta.authors.length > 0) tokens['authors'] = meta.authors.join(', ');
    }

    const resolved = resolveUploadPath(pattern, tokens, ext, { sanitizeForCrossPlatform: true });
    return resolved ?? `${stem}.${ext}`;
  }

  private deduplicatePath(candidate: string, used: Map<string, BookFile>): string {
    if (!used.has(candidate.toLowerCase())) return candidate;
    const ext = extname(candidate);
    const stem = candidate.slice(0, candidate.length - ext.length);
    let n = 2;
    while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
    return `${stem} (${n})${ext}`;
  }

  private async scanExportDir(exportPath: string): Promise<string[]> {
    const results: string[] = [];
    await this.walkDir(exportPath, exportPath, results);
    return results;
  }

  private async walkDir(root: string, dir: string, results: string[]): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const st = await stat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await this.walkDir(root, full, results);
      } else if (st.isFile()) {
        results.push(relative(root, full));
      }
    }
  }

  safeJoin(exportPath: string, relPath: string): string | null {
    if (!relPath || relPath.includes('\0')) return null;
    const abs = resolve(exportPath, relPath);
    const prefix = exportPath.endsWith('/') ? exportPath : exportPath + '/';
    if (!abs.startsWith(prefix)) return null;
    return abs;
  }

  private isStale(srcStat: import('fs').Stats | null, destStat: import('fs').Stats | null): boolean {
    if (!srcStat) return false; // source gone; keep existing dest rather than delete-and-fail
    if (!destStat) return true;
    if (srcStat.size !== destStat.size) return true;
    if (srcStat.mtimeMs !== destStat.mtimeMs) return true;
    // Same device: diverged inodes mean a hardlink was severed by an in-place rewrite
    if (srcStat.dev === destStat.dev && srcStat.ino !== destStat.ino) return true;
    return false;
  }

  private async linkOrCopy(src: string, dest: string): Promise<'link' | 'copy'> {
    try {
      await link(src, dest);
      return 'link';
    } catch (err) {
      if (!isExdev(err)) throw err;
      await copyFile(src, dest);
      return 'copy';
    }
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      await this.pruneEmptyDirs(full);
      const remaining = await readdir(full).catch(() => null);
      if (remaining !== null && remaining.length === 0) {
        await rm(full, { recursive: true, force: true });
      }
    }
  }

  private async updateStatus(
    id: number,
    status: string,
    opts?: { lastSyncedAt?: Date; lastError?: string; clearError?: boolean; storageMode?: SyncStorageMode },
  ): Promise<void> {
    await this.db
      .update(syncTargets)
      .set({
        status,
        ...(opts?.lastSyncedAt ? { lastSyncedAt: opts.lastSyncedAt } : {}),
        ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
        ...(opts?.clearError ? { lastError: null } : {}),
        ...(opts?.storageMode ? { storageMode: opts.storageMode } : {}),
        updatedAt: new Date(),
      })
      .where(eq(syncTargets.id, id));
  }
}

function isExdev(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'EXDEV';
}
