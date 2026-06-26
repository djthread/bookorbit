import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { PendingDevice, SyncTarget } from '@bookorbit/types';

export interface SyncthingFolderDevice {
  deviceID: string;
  introducedBy?: string;
  encryptionPassword?: string;
}

export interface SyncthingFolderConfig {
  id: string;
  label: string;
  filesystemType?: string;
  path: string;
  type: string;
  devices: SyncthingFolderDevice[];
  [key: string]: unknown;
}

export interface SyncthingDeviceConfig {
  deviceID: string;
  name: string;
  addresses?: string[];
  [key: string]: unknown;
}

export interface SyncthingCompletion {
  completion: number;
  globalBytes: number;
  globalItems: number;
  needBytes: number;
  needItems: number;
  needDeletes: number;
  remoteState: string;
  sequence: number;
}

interface SyncthingPendingDeviceEntry {
  time: string;
  name: string;
  address: string;
}

@Injectable()
export class SyncthingClientService {
  private readonly logger = new Logger(SyncthingClientService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('sync.syncthingUrl')!;
    this.apiKey = this.config.get<string>('sync.syncthingApiKey')!;
  }

  async getDeviceId(): Promise<string> {
    const data = await this.request<{ myID: string }>('GET', '/rest/system/status');
    return data.myID;
  }

  async ensureFolder(target: Pick<SyncTarget, 'syncthingFolderId' | 'exportPath' | 'name' | 'mode'>): Promise<void> {
    const { syncthingFolderId: id, exportPath: path, name: label, mode: type } = target;

    let existing: SyncthingFolderConfig | null = null;
    try {
      existing = await this.request<SyncthingFolderConfig>('GET', `/rest/config/folders/${encodeURIComponent(id)}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    // E-readers are almost always FAT/exFAT, which can't store Unix permission
    // bits. Without ignorePerms, Syncthing sends permission metadata the device
    // can't apply, so the device flags the received files as locally changed on
    // its next scan — perpetually knocking the receive-only folder out of sync.
    // Ignoring perms marks files "no permission bits" so receivers never churn.
    if (existing) {
      await this.request('PATCH', `/rest/config/folders/${encodeURIComponent(id)}`, { label, path, type, ignorePerms: true });
    } else {
      const defaults = await this.request<SyncthingFolderConfig>('GET', '/rest/config/defaults/folder');
      const folder: SyncthingFolderConfig = { ...defaults, id, label, path, type, ignorePerms: true, devices: [] };
      await this.request('PUT', `/rest/config/folders/${encodeURIComponent(id)}`, folder);
    }

    this.logger.log(`[syncthing] ensureFolder id=${id}`);
  }

  async ensureDevice(deviceId: string, name?: string): Promise<void> {
    let existing: SyncthingDeviceConfig | null = null;
    try {
      existing = await this.request<SyncthingDeviceConfig>('GET', `/rest/config/devices/${encodeURIComponent(deviceId)}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    if (!existing) {
      const defaults = await this.request<SyncthingDeviceConfig>('GET', '/rest/config/defaults/device');
      const device: SyncthingDeviceConfig = { ...defaults, deviceID: deviceId, name: name ?? deviceId };
      await this.request('PUT', `/rest/config/devices/${encodeURIComponent(deviceId)}`, device);
      this.logger.log(`[syncthing] ensureDevice deviceId=${sanitizeLogValue(deviceId)}`);
    }
  }

  async listPendingDevices(): Promise<PendingDevice[]> {
    const raw = await this.request<Record<string, SyncthingPendingDeviceEntry>>('GET', '/rest/cluster/pending/devices');
    return Object.entries(raw).map(([deviceId, entry]) => ({
      deviceId,
      name: entry.name || null,
      address: entry.address,
      seen: entry.time,
    }));
  }

  async acceptDevice(deviceId: string, folderId: string, deviceName?: string): Promise<void> {
    await this.ensureDevice(deviceId, deviceName);

    const folder = await this.request<SyncthingFolderConfig>('GET', `/rest/config/folders/${encodeURIComponent(folderId)}`);
    const alreadyLinked = folder.devices.some((d) => d.deviceID === deviceId);
    if (!alreadyLinked) {
      folder.devices.push({ deviceID: deviceId });
      await this.request('PUT', `/rest/config/folders/${encodeURIComponent(folderId)}`, folder);
      this.logger.log(`[syncthing] acceptDevice deviceId=${sanitizeLogValue(deviceId)} folderId=${sanitizeLogValue(folderId)}`);
    }
  }

  async removeFolder(folderId: string): Promise<void> {
    try {
      await this.request('DELETE', `/rest/config/folders/${encodeURIComponent(folderId)}`);
      this.logger.log(`[syncthing] removeFolder folderId=${sanitizeLogValue(folderId)}`);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async getCompletion(folderId: string, deviceId: string): Promise<SyncthingCompletion> {
    return this.request<SyncthingCompletion>(
      'GET',
      `/rest/db/completion?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`,
    );
  }

  async isDeviceConnected(deviceId: string): Promise<boolean> {
    const data = await this.request<{ connections: Record<string, { connected?: boolean }> }>('GET', '/rest/system/connections');
    return data.connections?.[deviceId]?.connected ?? false;
  }

  async rescan(folderId: string): Promise<void> {
    await this.request('POST', `/rest/db/scan?folder=${encodeURIComponent(folderId)}`);
    this.logger.log(`[syncthing] rescan folderId=${sanitizeLogValue(folderId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(`[syncthing] ${method} ${path} failed error="${error}"`);
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = sanitizeLogValue(text || response.statusText);
      this.logger.error(`[syncthing] ${method} ${path} status=${response.status} error="${error}"`);
      const e = new SyncthingApiError(`Syncthing API error ${response.status}: ${error}`, response.status);
      throw e;
    }

    // 204 No Content
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

export class SyncthingApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SyncthingApiError';
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof SyncthingApiError && err.statusCode === 404;
}
