import { IsString, IsNotEmpty, IsArray, IsEnum, IsEmail, IsOptional, IsNumber, IsDate, IsBoolean } from 'class-validator';
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
