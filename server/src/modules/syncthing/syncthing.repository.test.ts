vi.mock('drizzle-orm', () => ({
  and: vi.fn((...clauses: unknown[]) => ({ op: 'and', clauses })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  inArray: vi.fn((left: unknown, right: unknown[]) => ({ op: 'inArray', left, right })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', text: strings.join(''), values })),
    {
      join: vi.fn((chunks: unknown[], separator: unknown) => ({ op: 'sql.join', chunks, separator })),
    },
  ),
}));

import { SyncthingRepository } from './syncthing.repository';

function makeRawTarget(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    userId: 10,
    name: 'Kobo Sync',
    syncthingFolderId: 'folder-abc',
    exportPath: '/data/sync/folder-abc',
    deviceId: null,
    mode: 'sendonly',
    layout: 'flat',
    storageMode: null,
    status: 'idle',
    lastCompletion: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDb() {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  return db;
}

describe('SyncthingRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findAllForUser', () => {
    it('returns targets with empty collectionIds when no join rows exist', async () => {
      const db = makeDb();

      // First query: db.select().from(syncTargets).where(...).orderBy(...)
      const targetsOrderBy = vi.fn().mockResolvedValue([makeRawTarget()]);
      const targetsWhere = vi.fn().mockReturnValue({ orderBy: targetsOrderBy });
      const targetsFrom = vi.fn().mockReturnValue({ where: targetsWhere });

      // Second query: syncTargetCollections
      const joinWhere = vi.fn().mockResolvedValue([]);
      const joinFrom = vi.fn().mockReturnValue({ where: joinWhere });

      db.select.mockReturnValueOnce({ from: targetsFrom }).mockReturnValueOnce({ from: joinFrom });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.findAllForUser(10);

      expect(result).toHaveLength(1);
      expect(result[0].collectionIds).toEqual([]);
      expect(result[0].userId).toBe(10);
    });

    it('groups collectionIds by target id', async () => {
      const db = makeDb();

      const target1 = makeRawTarget({ id: 1 });
      const target2 = makeRawTarget({ id: 2, name: 'Second' });

      const targetsOrderBy = vi.fn().mockResolvedValue([target1, target2]);
      const targetsWhere = vi.fn().mockReturnValue({ orderBy: targetsOrderBy });
      const targetsFrom = vi.fn().mockReturnValue({ where: targetsWhere });

      const joinWhere = vi.fn().mockResolvedValue([
        { syncTargetId: 1, collectionId: 5 },
        { syncTargetId: 1, collectionId: 6 },
        { syncTargetId: 2, collectionId: 7 },
      ]);
      const joinFrom = vi.fn().mockReturnValue({ where: joinWhere });

      db.select.mockReturnValueOnce({ from: targetsFrom }).mockReturnValueOnce({ from: joinFrom });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.findAllForUser(10);

      expect(result[0].collectionIds).toEqual([5, 6]);
      expect(result[1].collectionIds).toEqual([7]);
    });

    it('returns empty array when user has no targets', async () => {
      const db = makeDb();

      const targetsOrderBy = vi.fn().mockResolvedValue([]);
      const targetsWhere = vi.fn().mockReturnValue({ orderBy: targetsOrderBy });
      const targetsFrom = vi.fn().mockReturnValue({ where: targetsWhere });

      db.select.mockReturnValueOnce({ from: targetsFrom });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.findAllForUser(10);

      expect(result).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findById', () => {
    it('returns null when target does not exist', async () => {
      const db = makeDb();

      const limit = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      db.select.mockReturnValueOnce({ from });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.findById(99);

      expect(result).toBeNull();
    });

    it('returns mapped target with collectionIds', async () => {
      const db = makeDb();

      const raw = makeRawTarget({ lastSyncedAt: new Date('2026-06-01T12:00:00Z'), storageMode: 'hardlink' });

      const limit = vi.fn().mockResolvedValue([raw]);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });

      const joinWhere = vi.fn().mockResolvedValue([{ syncTargetId: 1, collectionId: 3 }]);
      const joinFrom = vi.fn().mockReturnValue({ where: joinWhere });

      db.select.mockReturnValueOnce({ from }).mockReturnValueOnce({ from: joinFrom });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.findById(1);

      expect(result).not.toBeNull();
      expect(result!.collectionIds).toEqual([3]);
      expect(result!.storageMode).toBe('hardlink');
      expect(result!.lastSyncedAt).toBe('2026-06-01T12:00:00.000Z');
      expect(result!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('insert', () => {
    it('inserts and returns the new row', async () => {
      const db = makeDb();
      const raw = makeRawTarget();
      const returning = vi.fn().mockResolvedValue([raw]);
      const values = vi.fn().mockReturnValue({ returning });
      db.insert.mockReturnValue({ values });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.insert({
        userId: 10,
        name: 'Kobo Sync',
        syncthingFolderId: 'folder-abc',
        exportPath: '/data/sync/folder-abc',
        mode: 'sendonly',
        status: 'idle',
      });

      expect(result).toEqual(raw);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 10, name: 'Kobo Sync' }));
    });
  });

  describe('update', () => {
    it('updates and returns the row on success', async () => {
      const db = makeDb();
      const raw = makeRawTarget({ name: 'Renamed' });
      const returning = vi.fn().mockResolvedValue([raw]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.update(1, 10, { name: 'Renamed' });

      expect(result).toEqual(raw);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'Renamed', updatedAt: expect.any(Date) }));
    });

    it('returns null when no row matched', async () => {
      const db = makeDb();
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      const repo = new SyncthingRepository(db as never);
      const result = await repo.update(99, 10, { name: 'Ghost' });

      expect(result).toBeNull();
    });
  });

  describe('setCollections', () => {
    it('deletes then inserts new collection rows in a transaction', async () => {
      const db = makeDb();

      const deleteWhere = vi.fn().mockResolvedValue(undefined);
      const txDelete = vi.fn().mockReturnValue({ where: deleteWhere });

      const insertValues = vi.fn().mockResolvedValue(undefined);
      const txInsert = vi.fn().mockReturnValue({ values: insertValues });

      const tx = { delete: txDelete, insert: txInsert };
      db.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => cb(tx));

      const repo = new SyncthingRepository(db as never);
      await repo.setCollections(1, [3, 4]);

      expect(txDelete).toHaveBeenCalled();
      expect(deleteWhere).toHaveBeenCalled();
      expect(txInsert).toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith([
        { syncTargetId: 1, collectionId: 3 },
        { syncTargetId: 1, collectionId: 4 },
      ]);
    });

    it('deletes without inserting when collectionIds is empty', async () => {
      const db = makeDb();

      const deleteWhere = vi.fn().mockResolvedValue(undefined);
      const txDelete = vi.fn().mockReturnValue({ where: deleteWhere });
      const txInsert = vi.fn();

      const tx = { delete: txDelete, insert: txInsert };
      db.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<void>) => cb(tx));

      const repo = new SyncthingRepository(db as never);
      await repo.setCollections(1, []);

      expect(txDelete).toHaveBeenCalled();
      expect(txInsert).not.toHaveBeenCalled();
    });
  });
});
