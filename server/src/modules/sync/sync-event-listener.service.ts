import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SyncTarget } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { COLLECTION_BOOKS_CHANGED, CollectionEventsService, type CollectionBooksChangedPayload } from '../collection/collection-events.service';
import { SyncReconcilerService } from './sync-reconciler.service';
import { SyncRepository } from './sync.repository';

const RECONCILE_DEBOUNCE_MS = 3_000;

type ReconcileTarget = Pick<SyncTarget, 'id' | 'syncthingFolderId' | 'exportPath' | 'layout'>;

/**
 * Reacts to collection membership changes by reconciling any sync target whose
 * collections include the changed collection. Debounced per target so a burst of
 * add/remove operations collapses into a single reconcile.
 */
@Injectable()
export class SyncEventListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncEventListenerService.name);
  private readonly enabled: boolean;
  private readonly debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly handler = (payload: CollectionBooksChangedPayload): void => {
    this.onCollectionBooksChanged(payload);
  };

  constructor(
    private readonly collectionEvents: CollectionEventsService,
    private readonly syncRepo: SyncRepository,
    private readonly reconciler: SyncReconcilerService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('sync.enabled') ?? false;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.collectionEvents.on(COLLECTION_BOOKS_CHANGED, this.handler);
  }

  onModuleDestroy(): void {
    this.collectionEvents.removeListener(COLLECTION_BOOKS_CHANGED, this.handler);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  private onCollectionBooksChanged(payload: CollectionBooksChangedPayload): void {
    this.syncRepo
      .findTargetsByCollectionId(payload.collectionId)
      .then((targets) => {
        for (const target of targets) this.scheduleReconcile(target);
      })
      .catch((err: unknown) => {
        const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
        this.logger.error(`[sync] resolve targets failed collectionId=${payload.collectionId} error="${msg}"`);
      });
  }

  private scheduleReconcile(target: ReconcileTarget): void {
    const pending = this.debounceTimers.get(target.id);
    if (pending) clearTimeout(pending);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(target.id);
      this.reconciler.reconcile(target).catch((err: unknown) => {
        const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
        this.logger.error(`[sync] event reconcile failed targetId=${target.id} error="${msg}"`);
      });
    }, RECONCILE_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();

    this.debounceTimers.set(target.id, timer);
  }
}
