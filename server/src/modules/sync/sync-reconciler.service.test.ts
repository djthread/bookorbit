import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import { link, copyFile, mkdir, readdir, rm, stat } from 'fs/promises';

import type { SyncLayout } from '@bookorbit/types';

import { SyncReconcilerService } from './sync-reconciler.service';
import { SyncthingClientService } from './syncthing-client.service';

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return {
    ...actual,
    link: vi.fn(),
    copyFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
  };
});

const mockLink = link as MockedFunction<typeof link>;
const mockCopyFile = copyFile as MockedFunction<typeof copyFile>;
const mockMkdir = mkdir as MockedFunction<typeof mkdir>;
const mockReaddir = readdir as MockedFunction<typeof readdir>;
const mockRm = rm as MockedFunction<typeof rm>;
const mockStat = stat as MockedFunction<typeof stat>;

function makeTarget(overrides: Partial<{ id: number; syncthingFolderId: string; exportPath: string; layout: SyncLayout }> = {}) {
  return {
    id: 1,
    syncthingFolderId: 'folder-abc',
    exportPath: '/data/sync/1',
    layout: 'author' as SyncLayout,
    ...overrides,
  };
}

function makeFile(overrides: Partial<{ bookId: number; absolutePath: string; format: string | null }> = {}) {
  return {
    bookId: 1,
    absolutePath: '/books/neuromancer.epub',
    format: 'epub',
    ...overrides,
  };
}

function makeMeta(
  bookId: number,
  overrides: Partial<{ title: string; authors: string[]; seriesName: string; seriesIndex: number; publishedYear: number }> = {},
) {
  return {
    bookId,
    title: 'Neuromancer',
    seriesName: null,
    seriesIndex: null,
    publishedYear: 1984,
    authors: ['William Gibson'],
    ...overrides,
  };
}

function makeSyncthing(): SyncthingClientService {
  return {
    rescan: vi.fn().mockResolvedValue(undefined),
  } as unknown as SyncthingClientService;
}

function makeService(opts: {
  files?: ReturnType<typeof makeFile>[];
  meta?: Map<number, ReturnType<typeof makeMeta>>;
  syncthing?: SyncthingClientService;
}) {
  const db = {} as ConstructorParameters<typeof SyncReconcilerService>[0];
  const syncthing = opts.syncthing ?? makeSyncthing();
  const service = new SyncReconcilerService(db, syncthing);

  vi.spyOn(service as any, 'resolveTargetFiles').mockResolvedValue(opts.files ?? []);
  vi.spyOn(service as any, 'resolvePatternMetadata').mockResolvedValue(opts.meta ?? new Map());
  const updateStatus = vi.spyOn(service as any, 'updateStatus').mockResolvedValue(undefined);

  return { service, syncthing, updateStatus };
}

describe('SyncReconcilerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined as any);
    mockLink.mockResolvedValue(undefined as any);
    mockCopyFile.mockResolvedValue(undefined as any);
    mockRm.mockResolvedValue(undefined as any);
    mockReaddir.mockResolvedValue([]);
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildRelativePaths', () => {
    it('resolves Author/Title.ext for the author layout', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const result = service.buildRelativePaths([file], meta, 'author');
      const relPath = result.get(file)!;
      expect(relPath).toBe('William Gibson/Neuromancer (1984).epub');
    });

    it('flattens to Title.ext (no folders) for the default flat layout', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const result = service.buildRelativePaths([file], meta);
      const relPath = result.get(file)!;
      expect(relPath).toBe('Neuromancer (1984).epub');
    });

    it('groups series into a folder but keeps standalone books flat for the series layout', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const standalone = makeFile({ bookId: 1, absolutePath: '/books/neuromancer.epub' });
      const inSeries = makeFile({ bookId: 2, absolutePath: '/books/count-zero.epub' });
      const meta = new Map([
        [1, makeMeta(1)],
        [2, makeMeta(2, { seriesName: 'Sprawl', seriesIndex: 2 })],
      ]);
      const result = service.buildRelativePaths([standalone, inSeries], meta, 'series');
      expect(result.get(standalone)!).toBe('Neuromancer (1984).epub');
      expect(result.get(inSeries)!.startsWith('Sprawl/')).toBe(true);
    });

    it('uses originalFilename as fallback when no metadata', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file = makeFile({ bookId: 99 });
      const result = service.buildRelativePaths([file], new Map());
      const relPath = result.get(file)!;
      expect(relPath).toContain('neuromancer');
    });

    it('falls back to format extension when absolutePath has no extension', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file = makeFile({ absolutePath: '/books/somebook', format: 'epub' });
      const meta = new Map([[1, makeMeta(1)]]);
      const result = service.buildRelativePaths([file], meta);
      const relPath = result.get(file)!;
      expect(relPath).toMatch(/\.epub$/);
    });

    it('deduplicates colliding paths by appending a counter', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file1 = makeFile({ bookId: 1, absolutePath: '/a/neuromancer.epub' });
      const file2 = makeFile({ bookId: 2, absolutePath: '/b/neuromancer.epub' });
      const meta = new Map([
        [1, makeMeta(1)],
        [2, makeMeta(2)],
      ]);
      const result = service.buildRelativePaths([file1, file2], meta);
      const paths = [...result.values()];
      expect(new Set(paths).size).toBe(2);
      expect(paths.some((p) => p.includes('(2)'))).toBe(true);
    });

    it('includes series subfolder when series metadata is present (author layout)', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1, { seriesName: 'Sprawl', seriesIndex: 1 })]]);
      const result = service.buildRelativePaths([file], meta, 'author');
      const relPath = result.get(file)!;
      expect(relPath).toContain('Sprawl');
    });

    it('returns an empty map for empty input', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      expect(service.buildRelativePaths([], new Map()).size).toBe(0);
    });
  });

  describe('safeJoin', () => {
    it('returns the joined path within exportPath', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      const result = service.safeJoin('/data/sync/1', 'Author/Title.epub');
      expect(result).toBe('/data/sync/1/Author/Title.epub');
    });

    it('returns null for a path traversal attempt', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      expect(service.safeJoin('/data/sync/1', '../../../etc/passwd')).toBeNull();
    });

    it('returns null for a null byte in relPath', () => {
      const service = new SyncReconcilerService({} as any, {} as any);
      expect(service.safeJoin('/data/sync/1', 'foo\0bar')).toBeNull();
    });
  });

  describe('reconcile', () => {
    it('hardlinks a new file into the export dir', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service } = makeService({ files: [file], meta });

      mockReaddir.mockResolvedValue([]);

      await service.reconcile(makeTarget());

      expect(mockLink).toHaveBeenCalledWith('/books/neuromancer.epub', expect.stringContaining('Neuromancer'));
      expect(mockCopyFile).not.toHaveBeenCalled();
    });

    it('falls back to copyFile on EXDEV error from link', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service } = makeService({ files: [file], meta });

      const exdev = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      mockLink.mockRejectedValueOnce(exdev);
      mockReaddir.mockResolvedValue([]);

      await service.reconcile(makeTarget());

      expect(mockCopyFile).toHaveBeenCalledWith('/books/neuromancer.epub', expect.any(String));
    });

    // Maps each path to a filesystem device id so detectStorageMode can compare
    // the export dir's device against each source file's device.
    function mockDevices(devByPath: Record<string, number>): void {
      mockStat.mockImplementation(((p: string) => {
        const dev = devByPath[p];
        if (dev === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve({ dev } as any);
      }) as never);
    }

    it('records storageMode=hardlink when the source shares the export filesystem', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service, updateStatus } = makeService({ files: [file], meta });

      mockReaddir.mockResolvedValue([]);
      mockDevices({ '/data/sync/1': 42, '/books/neuromancer.epub': 42 });

      await service.reconcile(makeTarget());

      expect(updateStatus).toHaveBeenCalledWith(1, 'idle', expect.objectContaining({ storageMode: 'hardlink' }));
    });

    it('records storageMode=copy when the source is on a different filesystem', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service, updateStatus } = makeService({ files: [file], meta });

      mockReaddir.mockResolvedValue([]);
      mockDevices({ '/data/sync/1': 42, '/books/neuromancer.epub': 7 });

      await service.reconcile(makeTarget());

      expect(updateStatus).toHaveBeenCalledWith(1, 'idle', expect.objectContaining({ storageMode: 'copy' }));
    });

    it('records storageMode=mixed when sources span multiple filesystems', async () => {
      const sameFs = makeFile({ bookId: 1, absolutePath: '/books/neuromancer.epub' });
      const otherFs = makeFile({ bookId: 2, absolutePath: '/mnt/extra/count-zero.epub' });
      const meta = new Map([
        [1, makeMeta(1)],
        [2, makeMeta(2, { title: 'Count Zero' })],
      ]);
      const { service, updateStatus } = makeService({ files: [sameFs, otherFs], meta });

      mockReaddir.mockResolvedValue([]);
      mockDevices({ '/data/sync/1': 42, '/books/neuromancer.epub': 42, '/mnt/extra/count-zero.epub': 7 });

      await service.reconcile(makeTarget());

      expect(updateStatus).toHaveBeenCalledWith(1, 'idle', expect.objectContaining({ storageMode: 'mixed' }));
    });

    it('records the mode even when no new files are materialized (already-synced target)', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service, updateStatus } = makeService({ files: [file], meta });

      // The file already exists in the export dir, so nothing is linked/copied.
      vi.spyOn(service as any, 'scanExportDir').mockResolvedValue(['William Gibson/Neuromancer (1984).epub']);
      mockDevices({ '/data/sync/1': 42, '/books/neuromancer.epub': 42 });

      await service.reconcile(makeTarget());

      expect(mockLink).not.toHaveBeenCalled();
      expect(updateStatus).toHaveBeenCalledWith(1, 'idle', expect.objectContaining({ storageMode: 'hardlink' }));
    });

    it('leaves storageMode unset for an empty target', async () => {
      const { service, updateStatus } = makeService({ files: [], meta: new Map() });

      await service.reconcile(makeTarget());

      const idleCall = updateStatus.mock.calls.find((c) => c[1] === 'idle');
      expect(idleCall).toBeDefined();
      expect((idleCall![2] as { storageMode?: string }).storageMode).toBeUndefined();
    });

    it('logs a warning and skips a file on non-EXDEV link errors', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service } = makeService({ files: [file], meta });

      const ioError = Object.assign(new Error('EIO'), { code: 'EIO' });
      mockLink.mockRejectedValueOnce(ioError);
      mockReaddir.mockResolvedValue([]);

      await expect(service.reconcile(makeTarget())).resolves.not.toThrow();
      expect(mockCopyFile).not.toHaveBeenCalled();
    });

    it('skips a file that already exists in the export dir', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service } = makeService({ files: [file], meta });

      const expectedRelPath = 'William Gibson/Neuromancer (1984).epub';
      mockReaddir
        .mockResolvedValueOnce([{ name: 'William Gibson', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as any])
        .mockResolvedValueOnce([
          { name: 'Neuromancer (1984).epub', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as any,
        ])
        .mockResolvedValue([]);
      mockStat.mockResolvedValue({ isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as any);

      vi.spyOn(service as any, 'scanExportDir').mockResolvedValue([expectedRelPath]);

      await service.reconcile(makeTarget());

      expect(mockLink).not.toHaveBeenCalled();
    });

    it('prunes files no longer in the collection', async () => {
      const meta = new Map<number, ReturnType<typeof makeMeta>>();
      const { service } = makeService({ files: [], meta });

      const staleRelPath = 'Old Author/Old Book.epub';
      vi.spyOn(service as any, 'scanExportDir').mockResolvedValue([staleRelPath]);

      await service.reconcile(makeTarget());

      expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('Old Book.epub'), { force: true });
    });

    it('calls syncthing.rescan after materializing files', async () => {
      const syncthing = makeSyncthing();
      const { service } = makeService({ syncthing });

      await service.reconcile(makeTarget());

      expect(syncthing.rescan).toHaveBeenCalledWith('folder-abc');
    });

    it('marks status as error and re-throws when syncthing.rescan fails', async () => {
      const syncthing = { rescan: vi.fn().mockRejectedValue(new Error('syncthing down')) } as unknown as SyncthingClientService;
      const { service } = makeService({ syncthing });

      const updateStatus = vi.spyOn(service as any, 'updateStatus').mockResolvedValue(undefined);

      await expect(service.reconcile(makeTarget())).rejects.toThrow('syncthing down');

      expect(updateStatus).toHaveBeenCalledWith(1, 'error', expect.objectContaining({ lastError: expect.stringContaining('syncthing down') }));
    });

    it('skips (warns) when a source file cannot be linked or copied', async () => {
      const file = makeFile();
      const meta = new Map([[1, makeMeta(1)]]);
      const { service } = makeService({ files: [file], meta });

      const noent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockLink.mockRejectedValue(noent);
      mockReaddir.mockResolvedValue([]);

      await expect(service.reconcile(makeTarget())).resolves.not.toThrow();
    });

    it('creates the export directory if it does not exist', async () => {
      const { service } = makeService({});

      await service.reconcile(makeTarget({ exportPath: '/data/sync/new' }));

      expect(mockMkdir).toHaveBeenCalledWith('/data/sync/new', { recursive: true });
    });
  });
});
