import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { SyncReconcilerService } from './sync-reconciler.service';
import { SyncRepository } from './sync.repository';

/**
 * Periodic safety sweep: reconciles every sync target on a schedule to catch
 * drift that the membership-change event misses — e.g. a book deleted outright
 * (cascade-removed from collections), a whole collection deleted, or on-disk
 * export state diverging from the collections. Idempotent with the event-driven
 * reconcile; a re-entrancy guard prevents overlapping sweeps.
 */
@Injectable()
export class SyncSweepService {
  private readonly logger = new Logger(SyncSweepService.name);
  private readonly enabled: boolean;
  private running = false;

  constructor(
    private readonly syncRepo: SyncRepository,
    private readonly reconciler: SyncReconcilerService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('sync.enabled') ?? false;
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;

    const event = 'sync.sweep';
    const startedAt = Date.now();
    try {
      const targets = await this.syncRepo.findAll();
      this.logger.log(`[${event}] [start] targetCount=${targets.length}`);

      let reconciled = 0;
      let failed = 0;
      for (const target of targets) {
        try {
          await this.reconciler.reconcile(target);
          reconciled++;
        } catch (err) {
          failed++;
          const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
          this.logger.warn(`[${event}] [target_fail] targetId=${target.id} error="${msg}"`);
        }
      }

      this.logger.log(`[${event}] [end] durationMs=${Date.now() - startedAt} reconciled=${reconciled} failed=${failed}`);
    } catch (err) {
      const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(`[${event}] [fail] durationMs=${Date.now() - startedAt} error="${msg}"`);
    } finally {
      this.running = false;
    }
  }
}
