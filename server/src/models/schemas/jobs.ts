import { JobScope, JobStatus } from '../enums.js';
import { JobLocation } from './locations.js';
import { ApplyPolicy } from './applyPolicy.js';

/** A job as the API returns it. */
export interface Job {
  _id: string;
  id: string;
  title: string;
  jobScope: JobScope[];
  companyName: string;
  publishDate: Date;
  citySymbol: number;
  description: string; // sanitized HTML
  jobId: number;
  contactPersonName?: string;
  contactPersonPhone?: string;
  contactPersonEmail?: string;
  externalLink?: string;
  uploadBy?: string;
  status: JobStatus;
  comments?: string;
  location?: Partial<JobLocation>;
  requiredSkills: string[];
  requiredSkillsDetails?: Record<string, string>;
  isSponsored: boolean;
  isMarked: boolean;
  isSelfApply: boolean;
  /** Per-job override (content managers only): null = inherit the site-wide default. */
  quickApplyOverride?: boolean | null;
  /** Per-job override (content managers only): null = inherit the site-wide default. */
  quickApplyWithoutCvOverride?: boolean | null;
  /** What applies to this job right now (override ?? default). */
  applyPolicy?: ApplyPolicy;
  /** false = private (unlisted). See jobBoard.ts. */
  isPublic?: boolean;
  /** Pinned to the top of the public board since then; null = not pinned. */
  pinnedAt?: Date | null;
  /** Archived (soft-deleted) at; null = live. */
  deletedAt?: Date | null;
  /** Staff only: who archived it. */
  deletedBy?: string | null;
  /** Staff only: board fields set on the management screen (integrations don't overwrite them). */
  managedFields?: string[];
  dateToDisplay?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
