import { JobScope, JobStatus } from '../enums.js';
import { JobLocation } from './locations.js';
import { ApplyPolicy, CvRule, GuestMode } from './applyPolicy.js';

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
  /** תנאי סף: plain text the candidate confirms before an application is accepted; null = none (thresholdCondition.ts). */
  thresholdCondition?: string | null;
  uploadBy?: string;
  status: JobStatus;
  comments?: string;
  location?: Partial<JobLocation>;
  requiredSkills: string[];
  requiredSkillsDetails?: Record<string, string>;
  isSponsored: boolean;
  isMarked: boolean;
  /** The effective guest mode is 'self' (הגשה עצמאית). Salesforce: isSelfApply_cambium__c. */
  isSelfApply: boolean;
  /** Per-job overrides (content managers only): null = inherit the site-wide default. See applyPolicy.ts. */
  guestModeOverride?: GuestMode | null;
  quickCvOverride?: CvRule | null;
  regularCvOverride?: CvRule | null;
  /** What applies to this job right now (override ?? default). */
  applyPolicy?: ApplyPolicy;
  /** Pinned to the top of the public board since then; null = not pinned. */
  pinnedAt?: Date | null;
  /** Last bump (הקפצה); listed as if published then. */
  bumpedAt?: Date | null;
  /** Archived (soft-deleted) at; null = live. */
  deletedAt?: Date | null;
  /** Staff only: who archived it. */
  deletedBy?: string | null;
  /** Staff only: board fields set on the management screen (integrations don't overwrite them). */
  managedFields?: string[];
  /** Imported from the existing site: read-only on this platform (staff views only). */
  importedFromLive?: boolean;
  /** Public: a job of the existing site; applications to it are not taken here (errorMiddleware.JobOnExistingSiteError). */
  onExistingSite?: boolean;
  /** The existing site's job: 'mirror' (read from Salesforce, read-only here) or 'owned' (after the cutover). */
  legacyState?: 'mirror' | 'owned' | null;
  /** Its Position Case in Salesforce (the same Case before and after the cutover). */
  legacySfId?: string | null;
  dateToDisplay?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
