import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncSweepService } from './sync-sweep.service';

function makeSweep(enabled = true) {
  const syncRepo = { findAll: vi.fn().mockResolvedValue([]) };
  const reconciler = { reconcile: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn(() => enabled) };

  const service = new SyncSweepService(syncRepo as never, reconciler as never, config as never);
  return { service, syncRepo, reconciler };
}

const targetA = { id: 1, syncthingFolderId: 'fa', exportPath: '/data/sync/fa', layout: 'flat' };
const targetB = { id: 2, syncthingFolderId: 'fb', exportPath: '/data/sync/fb', layout: 'author' };

describe('SyncSweepService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when sync is disabled', async () => {
    const { service, syncRepo, reconciler } = makeSweep(false);
    await service.sweep();
    expect(syncRepo.findAll).not.toHaveBeenCalled();
    expect(reconciler.reconcile).not.toHaveBeenCalled();
  });

  it('reconciles every target', async () => {
    const { service, syncRepo, reconciler } = makeSweep();
    syncRepo.findAll.mockResolvedValue([targetA, targetB]);

    await service.sweep();

    expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
    expect(reconciler.reconcile).toHaveBeenCalledWith(targetA);
    expect(reconciler.reconcile).toHaveBeenCalledWith(targetB);
  });

  it('continues reconciling remaining targets when one fails', async () => {
    const { service, syncRepo, reconciler } = makeSweep();
    syncRepo.findAll.mockResolvedValue([targetA, targetB]);
    reconciler.reconcile.mockRejectedValueOnce(new Error('boom'));

    await service.sweep();

    expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping runs while one is in flight', async () => {
    const { service, syncRepo, reconciler } = makeSweep();
    let release!: () => void;
    syncRepo.findAll.mockReturnValue(new Promise((resolve) => (release = () => resolve([targetA]))));

    const first = service.sweep();
    await service.sweep(); // should early-return, guarded by `running`
    release();
    await first;

    expect(syncRepo.findAll).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
  });
});
