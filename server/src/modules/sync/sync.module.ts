import { Module } from '@nestjs/common';

import { SyncthingClientService } from './syncthing-client.service';

@Module({
  providers: [SyncthingClientService],
  exports: [SyncthingClientService],
})
export class SyncModule {}
