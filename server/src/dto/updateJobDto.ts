import { IsString, IsEmail, IsArray, IsOptional, IsPhoneNumber, IsDateString, IsNumber, IsEnum, IsDate, IsBoolean } from 'class-validator';
import { JobStatus } from '../models/enums.js';
import { Transform, Type } from 'class-transformer';

export class UpdateJobDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsOptional()
  jobScope?: string[];

  @IsString()
  @IsOptional()
  companyName?: string;

  @IsDate()
  @IsOptional()
  @Type(() => Date)
  publishDate?: Date;

  @IsNumber()
  @IsOptional()
  citySymbol?: number;

  @IsString()
  @IsOptional()
  description?: string; // HTML content

  @IsString()
  @IsOptional()
  contactPersonName?: string;

  @IsOptional()
  @IsString()
  contactPersonPhone?: string;

  @Transform(({ value }) => value === '' ? null : value)
  @IsOptional()
  @IsEmail()
  contactPersonEmail?: string;

  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  @IsString()
  uploadBy?: string;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsOptional()
  @IsString()
  externalLink?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredSkills?: string[];

  @IsOptional()
  @IsBoolean()
  isSponsored?: boolean;

  @IsOptional()
  @IsBoolean()
  isMarked?: boolean;

  @IsOptional()
  @IsBoolean()
  isSelfApply?: boolean;

  // Apply policy overrides: true / false, or null = inherit the site-wide default.
  @IsOptional()
  @IsBoolean()
  quickApplyOverride?: boolean | null;

  @IsOptional()
  @IsBoolean()
  quickApplyWithoutCvOverride?: boolean | null;

  /** false = private (unlisted): not on the board, map, public API or MCP. */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /** true = a future publishDate is meant (scheduled publishing; hidden until then). Not stored. */
  @IsOptional()
  @IsBoolean()
  schedulePublish?: boolean;
}
