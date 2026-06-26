import { index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { collections } from './collections';
import { users } from './auth';

export const syncTargets = pgTable(
  'sync_targets',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    syncthingFolderId: text('syncthing_folder_id').notNull(),
    exportPath: text('export_path').notNull(),
    deviceId: text('device_id'),
    mode: text('mode').notNull().default('sendonly'),
    layout: text('layout').notNull().default('flat'),
    storageMode: text('storage_mode'),
    status: text('status').notNull().default('idle'),
    lastCompletion: integer('last_completion'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('sync_targets_user_name_uidx').on(t.userId, t.name)],
);

export const syncTargetCollections = pgTable(
  'sync_target_collections',
  {
    syncTargetId: integer('sync_target_id')
      .notNull()
      .references(() => syncTargets.id, { onDelete: 'cascade' }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.syncTargetId, t.collectionId] }), index('sync_target_collections_collection_id_idx').on(t.collectionId)],
);
