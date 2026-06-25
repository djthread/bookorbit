export type SyncTargetStatus = 'idle' | 'reconciling' | 'syncing' | 'error';

export type SyncTargetMode = 'sendonly';

export interface SyncTarget {
  id: number;
  name: string;
  syncthingFolderId: string;
  exportPath: string;
  deviceId: string | null;
  mode: SyncTargetMode;
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
}

export interface UpdateSyncTargetPayload {
  name?: string;
  collectionIds?: number[];
}

export interface SyncTargetProgress {
  targetId: number;
  status: SyncTargetStatus;
  lastCompletion: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  ourDeviceId: string;
  pendingDevices: PendingDevice[];
}

export interface PendingDevice {
  deviceId: string;
  name: string | null;
  address: string;
  seen: string;
}
