import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  DEFAULT_SYNC_LAYOUT,
  type SyncLayout,
  type SyncStorageMode,
  type SyncTarget,
  type SyncTargetMode,
  type SyncTargetStatus,
} from '@bookorbit/types';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { syncTargetCollections, syncTargets } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;
type RawTarget = typeof syncTargets.$inferSelect;

export type SyncTargetRow = SyncTarget & { userId: number };

@Injectable()
export class SyncRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findAllForUser(userId: number): Promise<SyncTargetRow[]> {
    const rows = await this.db.select().from(syncTargets).where(eq(syncTargets.userId, userId)).orderBy(syncTargets.name);
    return this.attachCollectionIds(rows);
  }

  async findAll(): Promise<SyncTargetRow[]> {
    const rows = await this.db.select().from(syncTargets).orderBy(syncTargets.id);
    return this.attachCollectionIds(rows);
  }

  async findById(id: number): Promise<SyncTargetRow | null> {
    const [row] = await this.db.select().from(syncTargets).where(eq(syncTargets.id, id)).limit(1);
    if (!row) return null;
    const [result] = await this.attachCollectionIds([row]);
    return result ?? null;
  }

  async findTargetsByCollectionId(collectionId: number): Promise<SyncTargetRow[]> {
    const rows = await this.db
      .select()
      .from(syncTargetCollections)
      .innerJoin(syncTargets, eq(syncTargets.id, syncTargetCollections.syncTargetId))
      .where(eq(syncTargetCollections.collectionId, collectionId));
    return this.attachCollectionIds(rows.map((r) => r.sync_targets));
  }

  async insert(values: typeof syncTargets.$inferInsert): Promise<RawTarget> {
    const [row] = await this.db.insert(syncTargets).values(values).returning();
    return row;
  }

  async update(id: number, userId: number, values: Partial<typeof syncTargets.$inferInsert>): Promise<RawTarget | null> {
    const [row] = await this.db
      .update(syncTargets)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(syncTargets.id, id), eq(syncTargets.userId, userId)))
      .returning();
    return row ?? null;
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.db.delete(syncTargets).where(and(eq(syncTargets.id, id), eq(syncTargets.userId, userId)));
  }

  async setCollections(targetId: number, collectionIds: number[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(syncTargetCollections).where(eq(syncTargetCollections.syncTargetId, targetId));
      if (collectionIds.length > 0) {
        await tx.insert(syncTargetCollections).values(collectionIds.map((collectionId) => ({ syncTargetId: targetId, collectionId })));
      }
    });
  }

  private async attachCollectionIds(rows: RawTarget[]): Promise<SyncTargetRow[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const joinRows = await this.db
      .select({ syncTargetId: syncTargetCollections.syncTargetId, collectionId: syncTargetCollections.collectionId })
      .from(syncTargetCollections)
      .where(inArray(syncTargetCollections.syncTargetId, ids));

    const byTarget = new Map<number, number[]>();
    for (const jr of joinRows) {
      const list = byTarget.get(jr.syncTargetId) ?? [];
      list.push(jr.collectionId);
      byTarget.set(jr.syncTargetId, list);
    }

    return rows.map((row) => this.mapRow(row, byTarget.get(row.id) ?? []));
  }

  private mapRow(row: RawTarget, collectionIds: number[]): SyncTargetRow {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      syncthingFolderId: row.syncthingFolderId,
      exportPath: row.exportPath,
      deviceId: row.deviceId,
      mode: (row.mode as SyncTargetMode) ?? 'sendonly',
      layout: (row.layout as SyncLayout) ?? DEFAULT_SYNC_LAYOUT,
      storageMode: (row.storageMode as SyncStorageMode | null) ?? null,
      status: (row.status as SyncTargetStatus) ?? 'idle',
      lastCompletion: row.lastCompletion,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastError: row.lastError,
      collectionIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
