import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SYNC_LAYOUTS, type SyncLayout } from '@bookorbit/types';

export class CreateSyncTargetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  collectionIds: number[];

  @IsOptional()
  @IsIn(SYNC_LAYOUTS)
  layout?: SyncLayout;
}
