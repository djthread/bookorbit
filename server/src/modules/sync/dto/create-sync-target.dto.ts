import { ArrayNotEmpty, IsArray, IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateSyncTargetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  collectionIds: number[];
}
