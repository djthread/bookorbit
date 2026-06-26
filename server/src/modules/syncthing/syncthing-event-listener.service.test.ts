import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLECTION_BOOKS_CHANGED } from '../collection/collection-events.service';
import { SyncthingEventListenerService } from './syncthing-event-listener.service';

function makeListener(enabled = true) {
  const collectionEvents = { on: vi.fn(), removeListener: vi.fn() };
  const syncRepo = { findTargetsByCollectionId: vi.fn().mockResolvedValue([]) };
  const reconciler = { reconcile: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn(() => enabled) };

  const listener = new SyncthingEventListenerService(collectionEvents as never, syncRepo as never, reconciler as never, config as never);
  return { listener, collectionEvents, syncRepo, reconciler };
}

const target = { id: 7, syncthingFolderId: 'f7', exportPath: '/data/sync/f7', layout: 'flat' };

describe('SyncthingEventListenerService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not subscribe when sync is disabled', () => {
    const { listener, collectionEvents } = makeListener(false);
    listener.onModuleInit();
    expect(collectionEvents.on).not.toHaveBeenCalled();
  });

  it('subscribes to collection book changes when enabled', () => {
    const { listener, collectionEvents } = makeListener();
    listener.onModuleInit();
    expect(collectionEvents.on).toHaveBeenCalledWith(COLLECTION_BOOKS_CHANGED, expect.any(Function));
  });

  it('debounces repeated changes into a single reconcile per target', async () => {
    const { listener, collectionEvents, syncRepo, reconciler } = makeListener();
    listener.onModuleInit();
    const handler = collectionEvents.on.mock.calls[0][1] as (p: unknown) => void;
    syncRepo.findTargetsByCollectionId.mockResolvedValue([target]);

    handler({ collectionId: 3, userId: 1 });
    handler({ collectionId: 3, userId: 1 });
    await vi.advanceTimersByTimeAsync(0); // flush the findTargets promises

    expect(reconciler.reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcile).toHaveBeenCalledWith(target);
  });

  it('removes its listener on destroy', () => {
    const { listener, collectionEvents } = makeListener();
    listener.onModuleInit();
    listener.onModuleDestroy();
    expect(collectionEvents.removeListener).toHaveBeenCalledWith(COLLECTION_BOOKS_CHANGED, expect.any(Function));
  });
});
