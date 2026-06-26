import { IsNotEmpty, IsString } from 'class-validator';

export class AcceptDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;
}
