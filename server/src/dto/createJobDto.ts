import { IsObject, IsString, IsNotEmpty, IsArray, IsEnum, IsEmail, IsOptional, IsNumber, IsDate, IsBoolean, IsIn, MaxLength } from 'class-validator';
import { THRESHOLD_CONDITION_LIMITS } from '../models/schemas/thresholdCondition.js';
import { JobScope, JobStatus } from '../models/enums.js';
import { Transform, Type } from 'class-transformer';


export class CreateJobDTO {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsArray()
  @IsEnum(JobScope, { each: true })
  @IsNotEmpty()
  jobScope: JobScope[];

  @IsString()
  @IsNotEmpty()
  companyName: string;

  @IsDate()
  @IsNotEmpty()
  @Type(() => Date)
  publishDate: Date;

  @IsNumber()
  @IsNotEmpty()
  citySymbol: number;

  @IsString()
  @IsNotEmpty()
  description: string; // HTML content

  @IsOptional()
  @IsString()
  @Transform(({ value }) => value === '' ? undefined : value)
  contactPersonName?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => value === '' ? undefined : value)
  contactPersonPhone?: string;

  @IsOptional()
  @IsEmail()
  @Transform(({ value }) => value === '' ? undefined : value)
  contactPersonEmail?: string;

  @IsString()
  @IsNotEmpty()
  uploadBy: string;

  @IsEnum(JobStatus)
  @IsNotEmpty()
  status: JobStatus;

  @IsOptional()
  @IsString()
  comments?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => value === '' ? undefined : value)
  externalLink?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  requiredSkills: string[];

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

  constructor(
    title: string,
    jobScope: JobScope[],
    companyName: string,
    publishDate: Date,
    citySymbol: number,
    description: string,
    contactPersonEmail: string,
    externalLink: string,
    uploadBy: string,
    status: JobStatus,
    requiredSkills: string[],
    contactPersonName?: string,
    contactPersonPhone?: string,
    comments?: string,
    isSponsored?: boolean,
    isMarked?: boolean,
    isSelfApply?: boolean,
  ) {
    this.title = title;
    this.jobScope = jobScope;
    this.companyName = companyName;
    this.publishDate = publishDate;
    this.citySymbol = citySymbol;
    this.description = description;
    this.contactPersonName = contactPersonName;
    this.contactPersonPhone = contactPersonPhone;
    this.contactPersonEmail = contactPersonEmail;
    this.externalLink = externalLink;
    this.uploadBy = uploadBy;
    this.status = status;
    this.requiredSkills = requiredSkills;
    this.comments = comments;
    this.isSponsored = isSponsored;
    this.isMarked = isMarked;
    this.isSelfApply = isSelfApply;

  }
}
