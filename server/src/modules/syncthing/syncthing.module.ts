import { Module } from '@nestjs/common';

import { CollectionModule } from '../collection/collection.module';
import { SyncthingController } from './syncthing.controller';
import { SyncthingRepository } from './syncthing.repository';
import { SyncthingService } from './syncthing.service';
import { SyncthingClientService } from './syncthing-client.service';
import { SyncthingReconcilerService } from './syncthing-reconciler.service';
import { SyncthingEventListenerService } from './syncthing-event-listener.service';
import { SyncthingSweepService } from './syncthing-sweep.service';

@Module({
  imports: [CollectionModule],
  controllers: [SyncthingController],
  providers: [
    SyncthingService,
    SyncthingRepository,
    SyncthingClientService,
    SyncthingReconcilerService,
    SyncthingEventListenerService,
    SyncthingSweepService,
  ],
  exports: [SyncthingService, SyncthingClientService, SyncthingReconcilerService],
})
export class SyncthingModule {}
