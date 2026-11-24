import { IsString, IsEmail, IsDateString, IsPhoneNumber, IsArray, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class UpdateUserDto {

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsPhoneNumber()
  @IsOptional()
  phoneNumber?: string;

  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @IsString()
  @IsOptional()
  gender?: string;

  @IsString()
  @IsOptional()
  idNumber?: string | null;

  @IsNumber()
  @IsOptional()
  citySymbol?: number;

  @IsString()
  @IsOptional()
  password?: string;

  @IsArray()
  @IsOptional()
  skills?: string[];

  @IsString()
  @IsOptional()
  cvFileUrl?: string;

  @IsBoolean()
  hasAppliedToJob?: boolean;

}
