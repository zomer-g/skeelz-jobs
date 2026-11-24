import { IsObject, IsString, IsEmail, IsArray, IsOptional, IsPhoneNumber, IsDateString, IsNumber, IsEnum, IsDate, IsBoolean, IsIn, MaxLength } from 'class-validator';
import { THRESHOLD_CONDITION_LIMITS } from '../models/schemas/thresholdCondition.js';
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

  // Ways to apply, per-job overrides (models/schemas/applyPolicy.ts); null = inherit the site-wide default.
  @IsOptional()
  @IsIn(['self', 'quick', 'none'])
  guestModeOverride?: 'self' | 'quick' | 'none' | null;

  @IsOptional()
  @IsIn(['required', 'optional'])
  quickCvOverride?: 'required' | 'optional' | null;

  @IsOptional()
  @IsIn(['required', 'optional'])
  regularCvOverride?: 'required' | 'optional' | null;

  /** Answers to the job form's added fields (settings screen; keyed by field id). Checked against the definitions by
   *  jobController (customFields.ts checkCustomValues); never sent to Salesforce. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, string | boolean | null>;

  /** תנאי סף (models/schemas/thresholdCondition.ts): plain text, '' or null = none. */
  @IsOptional()
  @IsString()
  @MaxLength(THRESHOLD_CONDITION_LIMITS.max)
  thresholdCondition?: string | null;

  /** Retired (there are no private jobs any more; the status decides): accepted from old clients, never stored. */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /** true = a future publishDate is meant (scheduled publishing; hidden until then). Not stored. */
  @IsOptional()
  @IsBoolean()
  schedulePublish?: boolean;
}
