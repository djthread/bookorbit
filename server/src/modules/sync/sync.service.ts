import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { basename, join } from 'path';

import { DEFAULT_SYNC_LAYOUT, type SyncTarget, type SyncTargetProgress } from '@bookorbit/types';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../common/types/request-user';
import { SyncRepository } from './sync.repository';
import { SyncthingClientService } from './syncthing-client.service';
import { SyncReconcilerService } from './sync-reconciler.service';
import type { CreateSyncTargetDto } from './dto/create-sync-target.dto';
import type { UpdateSyncTargetDto } from './dto/update-sync-target.dto';
import type { AcceptDeviceDto } from './dto/accept-device.dto';

const TARGET_NOT_FOUND = 'Sync target not found';
const TARGET_ACCESS_DENIED = 'No access to this sync target';

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  if (!(error instanceof Error)) return false;
  return (error.cause as { code?: unknown } | undefined)?.code === '23505';
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly syncEnabled: boolean;
  private readonly configExportPath: string;

  constructor(
    private readonly syncRepo: SyncRepository,
    private readonly syncthing: SyncthingClientService,
    private readonly reconciler: SyncReconcilerService,
    private readonly config: ConfigService,
  ) {
    this.syncEnabled = this.config.get<boolean>('sync.enabled') ?? false;
    this.configExportPath = this.config.get<string>('sync.exportPath') ?? join('/data', 'sync');
  }

  private assertEnabled(): void {
    if (!this.syncEnabled) {
      throw new ServiceUnavailableException('Device sync is not enabled on this server');
    }
  }

  private assertAccess(targetUserId: number, user: RequestUser): void {
    if (targetUserId !== user.id && !user.isSuperuser) {
      throw new ForbiddenException(TARGET_ACCESS_DENIED);
    }
  }

  private async findTargetForUserOrThrow(id: number, user: RequestUser) {
    const target = await this.syncRepo.findById(id);
    if (!target) throw new NotFoundException(TARGET_NOT_FOUND);
    this.assertAccess(target.userId, user);
    return target;
  }

  private triggerReconcile(target: Pick<SyncTarget, 'id' | 'syncthingFolderId' | 'exportPath' | 'layout'>): void {
    this.reconciler.reconcile(target).catch((err: unknown) => {
      const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(`[sync] Background reconcile failed targetId=${target.id} error="${msg}"`);
    });
  }

  async findAll(user: RequestUser): Promise<SyncTarget[]> {
    this.assertEnabled();
    return this.syncRepo.findAllForUser(user.id);
  }

  async findOne(id: number, user: RequestUser): Promise<SyncTarget> {
    this.assertEnabled();
    return this.findTargetForUserOrThrow(id, user);
  }

  async create(dto: CreateSyncTargetDto, user: RequestUser): Promise<SyncTarget> {
    this.assertEnabled();

    const syncthingFolderId = randomUUID();
    const exportPath = join(this.configExportPath, syncthingFolderId);

    let row: Awaited<ReturnType<SyncRepository['insert']>>;
    try {
      row = await this.syncRepo.insert({
        userId: user.id,
        name: dto.name,
        syncthingFolderId,
        exportPath,
        mode: 'sendonly',
        layout: dto.layout ?? DEFAULT_SYNC_LAYOUT,
        status: 'idle',
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A sync target with this name already exists');
      }
      throw error;
    }

    await this.syncRepo.setCollections(row.id, dto.collectionIds);

    const target = await this.syncRepo.findById(row.id);
    if (!target) throw new NotFoundException(TARGET_NOT_FOUND);

    this.syncthing.ensureFolder(target).catch((err: unknown) => {
      const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.error(`[sync] ensureFolder failed targetId=${target.id} error="${msg}"`);
    });

    this.triggerReconcile(target);

    return target;
  }

  async update(id: number, dto: UpdateSyncTargetDto, user: RequestUser): Promise<SyncTarget> {
    this.assertEnabled();

    const existing = await this.findTargetForUserOrThrow(id, user);

    try {
      const fields: Partial<{ name: string; layout: string }> = {};
      if (dto.name !== undefined) fields.name = dto.name;
      if (dto.layout !== undefined) fields.layout = dto.layout;
      if (Object.keys(fields).length > 0) {
        await this.syncRepo.update(id, existing.userId, fields);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A sync target with this name already exists');
      }
      throw error;
    }

    if (dto.collectionIds !== undefined) {
      await this.syncRepo.setCollections(id, dto.collectionIds);
    }

    const updated = await this.syncRepo.findById(id);
    if (!updated) throw new NotFoundException(TARGET_NOT_FOUND);

    // A layout change rewrites every export path, so reconcile to re-link + prune.
    const layoutChanged = dto.layout !== undefined && dto.layout !== existing.layout;
    if (dto.collectionIds !== undefined || layoutChanged) {
      this.triggerReconcile(updated);
    }

    return updated;
  }

  async remove(id: number, user: RequestUser): Promise<void> {
    this.assertEnabled();
    const existing = await this.findTargetForUserOrThrow(id, user);

    // Best-effort cleanup of the Syncthing folder + on-disk export dir. Failures
    // here must not block deletion of the target row.
    await this.syncthing.removeFolder(existing.syncthingFolderId).catch((err: unknown) => {
      const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[sync] removeFolder failed targetId=${existing.id} error="${msg}"`);
    });

    // Guard: only delete a directory that still looks like this target's managed
    // export dir (named after its folder id), never an arbitrary path.
    if (basename(existing.exportPath) === existing.syncthingFolderId) {
      await rm(existing.exportPath, { recursive: true, force: true }).catch((err: unknown) => {
        const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
        this.logger.warn(`[sync] export dir cleanup failed targetId=${existing.id} error="${msg}"`);
      });
    } else {
      this.logger.warn(`[sync] skipped export dir cleanup, unexpected path targetId=${existing.id}`);
    }

    await this.syncRepo.delete(id, existing.userId);
  }

  async getStatus(id: number, user: RequestUser): Promise<SyncTargetProgress> {
    this.assertEnabled();

    const target = await this.findTargetForUserOrThrow(id, user);

    const [ourDeviceId, pendingDevices] = await Promise.all([this.syncthing.getDeviceId(), this.syncthing.listPendingDevices()]);

    let lastCompletion = target.lastCompletion;
    if (target.deviceId) {
      try {
        const completion = await this.syncthing.getCompletion(target.syncthingFolderId, target.deviceId);
        lastCompletion = Math.round(completion.completion);
      } catch (err) {
        const msg = sanitizeLogValue(err instanceof Error ? err.message : String(err));
        this.logger.warn(`[sync] getCompletion failed targetId=${target.id} error="${msg}"`);
      }
    }

    return {
      targetId: target.id,
      status: target.status,
      lastCompletion,
      lastSyncedAt: target.lastSyncedAt,
      lastError: target.lastError,
      ourDeviceId,
      pendingDevices,
    };
  }

  async acceptDevice(id: number, dto: AcceptDeviceDto, user: RequestUser): Promise<SyncTarget> {
    this.assertEnabled();

    const target = await this.findTargetForUserOrThrow(id, user);

    // Syncthing's pending-device list is global, so the same device shows up under
    // every target in the UI. Guard against accepting a device onto a target that
    // is already paired with a different one — that would silently rebind the
    // folder and repoint progress tracking at the wrong device.
    if (target.deviceId && target.deviceId !== dto.deviceId) {
      throw new ConflictException('This target is already paired with another device. Delete and recreate the target to pair a different device.');
    }

    await this.syncthing.acceptDevice(dto.deviceId, target.syncthingFolderId);
    await this.syncRepo.update(id, target.userId, { deviceId: dto.deviceId });

    const updated = await this.syncRepo.findById(id);
    if (!updated) throw new NotFoundException(TARGET_NOT_FOUND);
    return updated;
  }

  async reconcile(id: number, user: RequestUser): Promise<void> {
    this.assertEnabled();
    const target = await this.findTargetForUserOrThrow(id, user);
    this.triggerReconcile(target);
  }
}
