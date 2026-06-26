import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';

import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AcceptDeviceDto } from './dto/accept-device.dto';
import { CreateSyncTargetDto } from './dto/create-sync-target.dto';
import { UpdateSyncTargetDto } from './dto/update-sync-target.dto';
import { SyncthingService } from './syncthing.service';

@Controller('syncthing')
@RequirePermission(Permission.Syncthing)
export class SyncthingController {
  constructor(private readonly syncService: SyncthingService) {}

  @Get('overview')
  getOverview() {
    return this.syncService.getOverview();
  }

  @Get('targets')
  findAll(@CurrentUser() user: RequestUser) {
    return this.syncService.findAll(user);
  }

  @Get('targets/:id')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.syncService.findOne(id, user);
  }

  @Post('targets')
  create(@Body() dto: CreateSyncTargetDto, @CurrentUser() user: RequestUser) {
    return this.syncService.create(dto, user);
  }

  @Patch('targets/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSyncTargetDto, @CurrentUser() user: RequestUser) {
    return this.syncService.update(id, dto, user);
  }

  @Delete('targets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.syncService.remove(id, user);
  }

  @Get('targets/:id/status')
  getStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.syncService.getStatus(id, user);
  }

  @Post('targets/:id/accept-device')
  acceptDevice(@Param('id', ParseIntPipe) id: number, @Body() dto: AcceptDeviceDto, @CurrentUser() user: RequestUser) {
    return this.syncService.acceptDevice(id, dto, user);
  }

  @Post('targets/:id/reconcile')
  @HttpCode(HttpStatus.NO_CONTENT)
  reconcile(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.syncService.reconcile(id, user);
  }
}
