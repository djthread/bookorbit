import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import { SyncService } from './sync.service';

function makeUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    id: 1,
    username: 'alice',
    name: 'Alice',
    email: null,
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { rules: [] } as never,
    ...overrides,
  };
}

function makeTarget(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    userId: 1,
    name: 'Kobo Sync',
    syncthingFolderId: 'folder-abc',
    exportPath: '/data/sync/folder-abc',
    deviceId: null,
    mode: 'sendonly' as const,
    status: 'idle' as const,
    lastCompletion: null,
    lastSyncedAt: null,
    lastError: null,
    collectionIds: [5],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeService(syncEnabled = true) {
  const syncRepo = {
    findAllForUser: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setCollections: vi.fn(),
  };

  const syncthing = {
    getDeviceId: vi.fn(),
    listPendingDevices: vi.fn(),
    getCompletion: vi.fn(),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    acceptDevice: vi.fn().mockResolvedValue(undefined),
  };

  const reconciler = {
    reconcile: vi.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: vi.fn((key: string) => {
      if (key === 'sync.enabled') return syncEnabled;
      if (key === 'sync.exportPath') return '/data/sync';
      return undefined;
    }),
  };

  const service = new SyncService(
    syncRepo as never,
    syncthing as never,
    reconciler as never,
    config as never,
  );

  return { service, syncRepo, syncthing, reconciler };
}

describe('SyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('feature flag', () => {
    it('throws ServiceUnavailableException when SYNC_ENABLED is false', async () => {
      const { service } = makeService(false);

      await expect(service.findAll(makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.findOne(1, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.create({ name: 'x', collectionIds: [1] }, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.update(1, {}, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.remove(1, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.getStatus(1, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.acceptDevice(1, { deviceId: 'x' }, makeUser())).rejects.toThrow(ServiceUnavailableException);
      await expect(service.reconcile(1, makeUser())).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('findAll', () => {
    it('returns all targets for the current user', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findAllForUser.mockResolvedValue([makeTarget()]);

      const result = await service.findAll(makeUser());

      expect(syncRepo.findAllForUser).toHaveBeenCalledWith(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when target does not exist', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(null);

      await expect(service.findOne(99, makeUser())).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user does not own the target', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ userId: 99 }));

      await expect(service.findOne(1, makeUser({ id: 1 }))).rejects.toThrow(ForbiddenException);
    });

    it('allows superuser to access any target', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ userId: 99 }));

      const result = await service.findOne(1, makeUser({ isSuperuser: true }));

      expect(result).toBeDefined();
    });
  });

  describe('create', () => {
    it('inserts a new target, sets collections, and returns hydrated target', async () => {
      const { service, syncRepo, syncthing, reconciler } = makeService();
      const raw = { id: 1, userId: 1, name: 'Kobo Sync', syncthingFolderId: 'f', exportPath: '/data/sync/f', mode: 'sendonly', status: 'idle' };
      syncRepo.insert.mockResolvedValue(raw);
      syncRepo.setCollections.mockResolvedValue(undefined);
      syncRepo.findById.mockResolvedValue(makeTarget());
      syncthing.ensureFolder.mockResolvedValue(undefined);
      reconciler.reconcile.mockResolvedValue(undefined);

      const result = await service.create({ name: 'Kobo Sync', collectionIds: [5] }, makeUser());

      expect(syncRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, name: 'Kobo Sync', mode: 'sendonly' }));
      expect(syncRepo.setCollections).toHaveBeenCalledWith(1, [5]);
      expect(result).toEqual(expect.objectContaining({ name: 'Kobo Sync' }));
    });

    it('maps unique constraint violations to ConflictException', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.insert.mockRejectedValue({ code: '23505' });

      await expect(service.create({ name: 'Duplicate', collectionIds: [1] }, makeUser())).rejects.toThrow(ConflictException);
    });

    it('triggers ensureFolder and reconcile as fire-and-forget after create', async () => {
      const { service, syncRepo, syncthing, reconciler } = makeService();
      const raw = { id: 1 };
      syncRepo.insert.mockResolvedValue(raw);
      syncRepo.setCollections.mockResolvedValue(undefined);
      syncRepo.findById.mockResolvedValue(makeTarget());
      syncthing.ensureFolder.mockResolvedValue(undefined);
      reconciler.reconcile.mockResolvedValue(undefined);

      await service.create({ name: 'Kobo Sync', collectionIds: [5] }, makeUser());

      await Promise.resolve();
      expect(syncthing.ensureFolder).toHaveBeenCalled();
      expect(reconciler.reconcile).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates name and returns the hydrated target', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById
        .mockResolvedValueOnce(makeTarget())
        .mockResolvedValueOnce(makeTarget({ name: 'Renamed' }));
      syncRepo.update.mockResolvedValue({ id: 1 });

      const result = await service.update(1, { name: 'Renamed' }, makeUser());

      expect(syncRepo.update).toHaveBeenCalledWith(1, 1, { name: 'Renamed' });
      expect(result.name).toBe('Renamed');
    });

    it('updates collections and triggers reconcile when collectionIds are provided', async () => {
      const { service, syncRepo, reconciler } = makeService();
      syncRepo.findById
        .mockResolvedValueOnce(makeTarget())
        .mockResolvedValueOnce(makeTarget({ collectionIds: [3, 4] }));
      syncRepo.setCollections.mockResolvedValue(undefined);
      reconciler.reconcile.mockResolvedValue(undefined);

      await service.update(1, { collectionIds: [3, 4] }, makeUser());

      expect(syncRepo.setCollections).toHaveBeenCalledWith(1, [3, 4]);
      await Promise.resolve();
      expect(reconciler.reconcile).toHaveBeenCalled();
    });

    it('does not trigger reconcile when only name changes', async () => {
      const { service, syncRepo, reconciler } = makeService();
      syncRepo.findById
        .mockResolvedValueOnce(makeTarget())
        .mockResolvedValueOnce(makeTarget({ name: 'Renamed' }));
      syncRepo.update.mockResolvedValue({ id: 1 });

      await service.update(1, { name: 'Renamed' }, makeUser());

      expect(reconciler.reconcile).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for non-owner update', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ userId: 99 }));

      await expect(service.update(1, { name: 'x' }, makeUser({ id: 1 }))).rejects.toThrow(ForbiddenException);
      expect(syncRepo.update).not.toHaveBeenCalled();
    });

    it('maps unique violations during update to ConflictException', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget());
      syncRepo.update.mockRejectedValue({ code: '23505' });

      await expect(service.update(1, { name: 'Duplicate' }, makeUser())).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes the target when the user owns it', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ userId: 1 }));
      syncRepo.delete.mockResolvedValue(undefined);

      await service.remove(1, makeUser({ id: 1 }));

      expect(syncRepo.delete).toHaveBeenCalledWith(1, 1);
    });

    it('throws ForbiddenException for non-owner remove', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ userId: 99 }));

      await expect(service.remove(1, makeUser({ id: 1 }))).rejects.toThrow(ForbiddenException);
      expect(syncRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns status with device id and pending devices', async () => {
      const { service, syncRepo, syncthing } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ deviceId: 'device-xyz' }));
      syncthing.getDeviceId.mockResolvedValue('our-device-id');
      syncthing.listPendingDevices.mockResolvedValue([{ deviceId: 'abc', name: 'Kobo', address: '192.168.1.2', seen: '2026-01-01T00:00:00Z' }]);
      syncthing.getCompletion.mockResolvedValue({ completion: 72.5 });

      const result = await service.getStatus(1, makeUser());

      expect(result.ourDeviceId).toBe('our-device-id');
      expect(result.pendingDevices).toHaveLength(1);
      expect(result.lastCompletion).toBe(73);
      expect(result.targetId).toBe(1);
    });

    it('skips completion fetch when target has no paired device', async () => {
      const { service, syncRepo, syncthing } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ deviceId: null, lastCompletion: 50 }));
      syncthing.getDeviceId.mockResolvedValue('our-device-id');
      syncthing.listPendingDevices.mockResolvedValue([]);

      const result = await service.getStatus(1, makeUser());

      expect(syncthing.getCompletion).not.toHaveBeenCalled();
      expect(result.lastCompletion).toBe(50);
    });

    it('returns stored completion when syncthing completion call fails', async () => {
      const { service, syncRepo, syncthing } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget({ deviceId: 'device-xyz', lastCompletion: 42 }));
      syncthing.getDeviceId.mockResolvedValue('our-device-id');
      syncthing.listPendingDevices.mockResolvedValue([]);
      syncthing.getCompletion.mockRejectedValue(new Error('Syncthing unreachable'));

      const result = await service.getStatus(1, makeUser());

      expect(result.lastCompletion).toBe(42);
    });
  });

  describe('acceptDevice', () => {
    it('calls syncthing acceptDevice and stores deviceId', async () => {
      const { service, syncRepo, syncthing } = makeService();
      syncRepo.findById
        .mockResolvedValueOnce(makeTarget({ deviceId: null }))
        .mockResolvedValueOnce(makeTarget({ deviceId: 'kobo-123' }));
      syncthing.acceptDevice.mockResolvedValue(undefined);
      syncRepo.update.mockResolvedValue({ id: 1 });

      const result = await service.acceptDevice(1, { deviceId: 'kobo-123' }, makeUser());

      expect(syncthing.acceptDevice).toHaveBeenCalledWith('kobo-123', 'folder-abc');
      expect(syncRepo.update).toHaveBeenCalledWith(1, 1, { deviceId: 'kobo-123' });
      expect(result.deviceId).toBe('kobo-123');
    });
  });

  describe('reconcile', () => {
    it('triggers fire-and-forget reconcile for the target', async () => {
      const { service, syncRepo, reconciler } = makeService();
      syncRepo.findById.mockResolvedValue(makeTarget());
      reconciler.reconcile.mockResolvedValue(undefined);

      await service.reconcile(1, makeUser());

      await Promise.resolve();
      expect(reconciler.reconcile).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    it('throws NotFoundException when target is missing', async () => {
      const { service, syncRepo } = makeService();
      syncRepo.findById.mockResolvedValue(null);

      await expect(service.reconcile(99, makeUser())).rejects.toThrow(NotFoundException);
    });
  });
});
