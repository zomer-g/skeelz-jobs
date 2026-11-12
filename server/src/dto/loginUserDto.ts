import { IsEmail, IsString } from 'class-validator';

export class LoginUserDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  constructor() {
    this.email = '';
    this.password = '';
  }
}
