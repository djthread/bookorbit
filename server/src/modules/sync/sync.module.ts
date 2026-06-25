import { Module } from '@nestjs/common';

import { CollectionModule } from '../collection/collection.module';
import { SyncController } from './sync.controller';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';
import { SyncthingClientService } from './syncthing-client.service';
import { SyncReconcilerService } from './sync-reconciler.service';
import { SyncEventListenerService } from './sync-event-listener.service';
import { SyncSweepService } from './sync-sweep.service';

@Module({
  imports: [CollectionModule],
  controllers: [SyncController],
  providers: [SyncService, SyncRepository, SyncthingClientService, SyncReconcilerService, SyncEventListenerService, SyncSweepService],
  exports: [SyncService, SyncthingClientService, SyncReconcilerService],
})
export class SyncModule {}
