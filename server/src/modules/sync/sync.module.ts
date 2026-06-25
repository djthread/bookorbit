import { Module } from '@nestjs/common';

import { SyncthingClientService } from './syncthing-client.service';
import { SyncReconcilerService } from './sync-reconciler.service';

@Module({
  providers: [SyncthingClientService, SyncReconcilerService],
  exports: [SyncthingClientService, SyncReconcilerService],
})
export class SyncModule {}
