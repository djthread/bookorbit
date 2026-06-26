import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
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

@Injectable()
export class SyncReconcilerService {
  private readonly logger = new Logger(SyncReconcilerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly syncthing: SyncthingClientService,
  ) {}

  async reconcile(target: Pick<SyncTarget, 'id' | 'syncthingFolderId' | 'exportPath' | 'layout'>): Promise<void> {
    const event = 'sync.reconcile';
    this.logger.log(`[${event}] [start] targetId=${target.id} layout=${target.layout}`);
    await this.updateStatus(target.id, 'reconciling');

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
      let pruned = 0;

      for (const [file, relPath] of desired) {
        if (existingPaths.has(relPath)) continue;
        const destPath = this.safeJoin(target.exportPath, relPath);
        if (!destPath) continue;
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
      // Detect the storage mode independently of what was transferred this run —
      // an already-synced target materializes nothing but we still want a mode.
      // Done before rescan so the throwaway probe file is never seen by Syncthing.
      // `undefined` (empty target / sources all missing) keeps the prior value.
      const storageMode = await this.detectStorageMode(target.exportPath, files);
      await this.syncthing.rescan(target.syncthingFolderId);
      await this.updateStatus(target.id, 'idle', { lastSyncedAt: new Date(), clearError: true, storageMode });

      this.logger.log(
        `[${event}] [end] targetId=${target.id} linked=${linked} copied=${copied} pruned=${pruned}${storageMode ? ` storageMode=${storageMode}` : ''}`,
      );
    } catch (err) {
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(`[${event}] [fail] targetId=${target.id} error="${errorMessage}"`);
      await this.updateStatus(target.id, 'error', { lastError: errorMessage });
      throw err;
    }
  }

  buildRelativePaths(files: BookFile[], metaByBookId: Map<number, PatternMeta>, layout: SyncLayout = DEFAULT_SYNC_LAYOUT): Map<BookFile, string> {
    const pattern = SYNC_LAYOUT_PATTERNS[layout] ?? SYNC_LAYOUT_PATTERNS[DEFAULT_SYNC_LAYOUT];
    const used = new Map<string, BookFile>();
    const result = new Map<BookFile, string>();

    for (const file of files) {
      const relPath = this.resolveRelPath(file, metaByBookId.get(file.bookId), pattern);
      const candidate = this.deduplicatePath(relPath, used);
      used.set(candidate, file);
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
    if (!used.has(candidate)) return candidate;
    const ext = extname(candidate);
    const stem = candidate.slice(0, candidate.length - ext.length);
    let n = 2;
    while (used.has(`${stem} (${n})${ext}`)) n++;
    return `${stem} (${n})${ext}`;
  }

  private async scanExportDir(exportPath: string): Promise<string[]> {
    const results: string[] = [];
    await this.walkDir(exportPath, exportPath, results);
    return results;
  }

  private async walkDir(root: string, dir: string, results: string[]): Promise<void> {
    let entries: Awaited<ReturnType<(path: string, opts: { withFileTypes: true }) => Promise<import('fs').Dirent[]>>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, String(entry.name));
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

  /**
   * Determines whether files land in the export dir as hardlinks or copies.
   *
   * Comparing `st.dev` is NOT enough: `link(2)` fails with `EXDEV` across
   * different mount points even when both sit on the same filesystem (the
   * common Docker case — `/books` and the export dir are separate bind mounts).
   * So we ground-truth it by attempting a throwaway hardlink from a real source
   * file into the export dir, exactly as {@link linkOrCopy} would. To bound the
   * cost while still catching a library that spans multiple filesystems, we
   * probe one representative source per distinct `st.dev`.
   *
   * Returns `undefined` when there is nothing to probe (empty target / all
   * sources missing) so the caller keeps the previously recorded mode.
   */
  private async detectStorageMode(exportPath: string, files: BookFile[]): Promise<SyncStorageMode | undefined> {
    if (files.length === 0) return undefined;

    const repBySrcDev = new Map<number, string>();
    for (const file of files) {
      const st = await stat(file.absolutePath).catch(() => null);
      if (!st) continue;
      if (!repBySrcDev.has(st.dev)) repBySrcDev.set(st.dev, file.absolutePath);
    }
    if (repBySrcDev.size === 0) return undefined;

    let sawLink = false;
    let sawCopy = false;
    for (const src of repBySrcDev.values()) {
      const result = await this.probeLink(src, exportPath);
      if (result === 'link') sawLink = true;
      else if (result === 'copy') sawCopy = true;
      if (sawLink && sawCopy) return 'mixed';
    }
    if (!sawLink && !sawCopy) return undefined;
    return sawLink ? 'hardlink' : 'copy';
  }

  /** Hardlinks `src` to a throwaway name in `exportPath` to see whether linking works there, then removes it. */
  private async probeLink(src: string, exportPath: string): Promise<'link' | 'copy' | null> {
    const dest = join(exportPath, `.bookorbit-linkprobe-${randomUUID()}`);
    try {
      await link(src, dest);
      return 'link';
    } catch (err) {
      if (isExdev(err)) return 'copy';
      return null;
    } finally {
      await rm(dest, { force: true }).catch(() => {});
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
      const full = join(dir, String(entry.name));
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
