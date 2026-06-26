export type SyncTargetStatus = 'idle' | 'reconciling' | 'syncing' | 'error';

export type SyncTargetMode = 'sendonly';

/**
 * On-device folder layout for exported files. Controls the relative path each
 * book file gets in the Syncthing export dir (and therefore how KOReader / the
 * "My Bookshelf" plugin groups them on the device).
 */
export type SyncLayout = 'flat' | 'series' | 'author';

export const SYNC_LAYOUTS: readonly SyncLayout[] = ['flat', 'series', 'author'] as const;

export const DEFAULT_SYNC_LAYOUT: SyncLayout = 'flat';

/** Maps a layout to the upload pattern fed to {@link resolveUploadPath}. */
export const SYNC_LAYOUT_PATTERNS: Record<SyncLayout, string> = {
  // All books in the root; titles dedup automatically. One tap to open in KOReader.
  flat: "<{title}|{originalFilename}>< ({year})>",
  // Group series into folders; standalone books fall to the root.
  series: "<{series}/><{seriesIndex}. ><{title}|{originalFilename}>< ({year})>",
  // Author/Series/Title tree — mirrors the library upload default.
  author: "<{authors:first}|Unknown Author>/<{series}/><{seriesIndex}. ><{title}|{originalFilename}>< ({year})>",
};

export interface SyncTarget {
  id: number;
  name: string;
  syncthingFolderId: string;
  exportPath: string;
  deviceId: string | null;
  mode: SyncTargetMode;
  layout: SyncLayout;
  status: SyncTargetStatus;
  lastCompletion: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  collectionIds: number[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSyncTargetPayload {
  name: string;
  collectionIds: number[];
  layout?: SyncLayout;
}

export interface UpdateSyncTargetPayload {
  name?: string;
  collectionIds?: number[];
  layout?: SyncLayout;
}

export interface SyncTargetProgress {
  targetId: number;
  status: SyncTargetStatus;
  lastCompletion: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  ourDeviceId: string;
  /** Whether the paired device currently has a live Syncthing connection. */
  deviceConnected: boolean;
  pendingDevices: PendingDevice[];
}

export interface PendingDevice {
  deviceId: string;
  name: string | null;
  address: string;
  seen: string;
}
