import { Module } from '@nestjs/common';

import { SyncController } from './sync.controller';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';
import { SyncthingClientService } from './syncthing-client.service';
import { SyncReconcilerService } from './sync-reconciler.service';

@Module({
  controllers: [SyncController],
  providers: [SyncService, SyncRepository, SyncthingClientService, SyncReconcilerService],
  exports: [SyncService, SyncthingClientService, SyncReconcilerService],
})
export class SyncModule {}
