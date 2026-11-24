import { IsString, IsEmail, IsDateString, IsPhoneNumber, IsArray, IsNumber, IsOptional, IsBoolean } from 'class-validator';

export class CreateUserDto {
  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsEmail()
  email: string;

  @IsPhoneNumber()
  phoneNumber: string;

  @IsDateString()
  dateOfBirth: string;

  @IsString()
  gender: string;

  @IsOptional()
  @IsString()
  idNumber?: string | null;

  /** Answers to the added sign-up fields (checked by customFieldsService.checkValues before this; keyed by field id). */
  @IsOptional()
  customFields?: Record<string, string | boolean | null>;

  @IsNumber()
  citySymbol: number;

  @IsArray()
  skills: string[];
  
  @IsOptional()
  @IsString()
  cvFileUrl?: string;

  @IsBoolean()
  hasAppliedToJob: boolean;
  

  constructor() {
    this.firstName = '';
    this.lastName = '';
    this.email = '';
    this.phoneNumber = '';
    this.dateOfBirth = '';
    this.gender = '';
    this.citySymbol = 0;
    this.skills = [];
    this.hasAppliedToJob = false;
  }
}
