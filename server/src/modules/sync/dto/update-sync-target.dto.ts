import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSyncTargetDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  collectionIds?: number[];
}
