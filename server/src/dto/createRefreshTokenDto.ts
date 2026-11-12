import { IsString, IsBoolean, IsDate } from 'class-validator';

export class CreateTokenDto {
  @IsString()
  userId: string;

  @IsString()
  refreshToken: string;

  @IsBoolean()
  expired: boolean;

  @IsDate()
  timestamp: Date;

  constructor() {
    this.userId = '';
    this.refreshToken = '';
    this.expired = false;
    this.timestamp = new Date();
  }
}
