import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { AcceptDeviceDto } from './dto/accept-device.dto';
import { CreateSyncTargetDto } from './dto/create-sync-target.dto';
import { UpdateSyncTargetDto } from './dto/update-sync-target.dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

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
