import { ReactNode } from "react";
import { Gender, UserRole } from "../../i18n/General.enums";

export interface LayoutProps {
  children: ReactNode,
}

export interface BodyProps {
  children: ReactNode
}

export interface HeaderProps {
  children: ReactNode,
}
export interface SubHeaderProps {
  location: string,
}

export interface PaginationType {
  totalJobs?: number;
  totalPages?: number;
  currentPage?: string | number; // Allow both types
  limit?: string | number;
}
export interface JobData {
  title: string;
  /** Staff: answers to the job form's added fields (settings screen), by field id. */
  customFields?: Record<string, string | boolean>;
  /** Everyone: the added fields shown on the job page (label + value; server-made, never sent back). */
  extraFields?: { label: string; value: string }[];
  location?: Location;
  locationPreview?: string;
  citySymbol: number,
  jobScope: string[];
  companyName: string;
  description: string;
  publishDate: Date;
  requiredSkills: string[];
  requiredSkillsDetails?: Record<string, string>; 
  status: string;
  contactPersonName: string,
  contactPersonPhone?: string,
  contactPersonEmail?: string,
  uploadBy?: string;
  _id?: string;
  comments: string;
  jobId?: number;
  dateToDisplay?: string;
  isSponsored: boolean;
  isMarked: boolean;
  /** The effective guest mode is 'self' (computed by the server; legacy field, also sent to Salesforce). */
  isSelfApply: boolean;
  /** Content-manager overrides: null/undefined = inherit the site-wide default (utils/applyPolicy.ts). */
  guestModeOverride?: GuestMode | null;
  quickCvOverride?: CvRule | null;
  regularCvOverride?: CvRule | null;
  /** Effective policy for this job, computed by the server. */
  applyPolicy?: ApplyPolicy;
  jobAppcreatedAt?: Date;
  externalLink?: string;
  /** תנאי סף: plain text the candidate confirms before applying; null/'' = none (server thresholdCondition.ts). */
  thresholdCondition?: string | null;
  /** A job of the existing site (imported, or mirrored until the cutover): shown, but takes no applications here. */
  onExistingSite?: boolean;
  /** Pinned to the top of the board since; null = not pinned. */
  pinnedAt?: Date | string | null;
  /** Imported from the existing site: read-only here (the server refuses every change, 409 job_read_only). */
  importedFromLive?: boolean;
  /** Last bump (הקפצה): listed as if published then. */
  bumpedAt?: Date | string | null;
  /** Archived (soft-deleted) at; content managers only. */
  deletedAt?: Date | string | null;
  /** Sent with a future publishDate: scheduled publishing. Not stored. */
  schedulePublish?: boolean;
}

/** How a visitor who is not signed in applies: self = directly to the employer, quick = guest form, none = sign in. */
export type GuestMode = 'self' | 'quick' | 'none';
export type CvRule = 'required' | 'optional';

/** Ways to apply and CV rules (server: models/schemas/applyPolicy.ts). */
export interface ApplyPolicy {
  guestMode: GuestMode;
  quickCv: CvRule;
  regularCv: CvRule;
}

export interface Location {
  citySymbol: number;
  city: string;
  /** WGS84 point of the settlement (map search); missing when unknown. */
  lat?: number | null;
  lng?: number | null;
}

export interface keyValue {
  key: string;
  value: string;
}

export interface LocationsAndDistricts {
  locations?: Location[];
  districts?: string[];
}

export interface RegisterFormValues {
  email: string;
  lastName: string;
  firstName: string;
  gender: Gender | null;
  dateOfBirth: Date | null;
  /** Israeli ID number (optional unless the sign-up fields setting requires it). */
  idNumber?: string;
  phoneNumber: string;
  citySymbol: number;
  skills?: string[];
  cvFileUrl?: string;
  hasAppliedToJob: boolean;
  /** Answers to the added sign-up fields (settings screen), by field id. */
  customFields?: Record<string, string | boolean>;
}

export interface guestApplyValues {
  email: string;
  fullName: string;
  phoneNumber: string;
  cvFilePath: string;
  /** Required terms box / optional marketing box (server/src/security/consent.ts). */
  consent: boolean;
  marketingConsent: boolean;
}

export interface EditUserValues {
  cvFileUrl?: string;
  skills?: string[];
}

export interface User {
  _id?:string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  dateOfBirth: Date;
  gender: string;
  citySymbol: number;
  location: Location;
  password?: string;
  skills: string[];
  role: UserRole;
  /** The roles this session carries (several per account since 23.11.2026); `role` is the highest. */
  roles?: UserRole[];
  /** Roles an admin blocked on this account (24.11.2026): "user" = the candidate role. Shown only to the person. */
  blockedRoles?: string[];
  jobApplicationsId: string[];
  cvFileUrl?: string;
}


export interface Guest {
  _id?:string;
  fullName: string;
  email: string;
  cvFilePath?: string;
  consent?: boolean;
  marketingConsent?: boolean;
}

export interface JobApplication {
  _id: string;
  jobId: string;
  date: Date;
  title?: string;
}

export interface ApplyJobButtonsProps {
  jobId: string;
  /** Effective policy (utils/applyPolicy.effectiveApplyPolicy). */
  applyPolicy: ApplyPolicy;
  openDirectApplyModal: () => void;
  handleGuestApply: () => void;
  /** Analytics only: the job has a threshold condition (never its text). */
  hasThreshold?: boolean;
  /** A job of the existing site: no application is taken here (server 409 job_on_existing_site). */
  onExistingSite?: boolean;
}


export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
  jobApplicationsId: string[];
}



export interface JobInfoData {
  icon: ReactNode;
  title: string;
  info: string;
  infoUrl?: boolean;
  /** Show the whole value (e.g. an employer's email on a self-apply job) instead of cutting it at 25 characters. */
  noTruncate?: boolean;
}

export interface JobCardData {
  color: string;
  jobData: JobData;
}

export interface filterOptions {
  includeRandomSponsoredJobs?:boolean;
  jobScopeIds?: string[];
  jobCitySymbol?: number[];
  jobDistricts?: string[];
  jobSkillsIds?: string[];
  jobStatus?: string[];
  inputValue?: string;
  sortField?: string | null;
  sortOrder?: string | null;
  pinned?: boolean;
  scheduled?: boolean;
  archived?: 'only' | 'include';
  page?: number;
  limit?: number;
}

export interface usersFilter {
  inputValue?: string;
  sortField?: string | null;
  sortOrder?: string | null;
  page?: number;
  limit?: number;
}

export interface userProfile {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  dateOfBirth: Date;
  gender: string;
  location?: Location;
  skills: string[];
  requiredSkillsDetails:keyValue[];
  role: UserRole;
  jobApplications: JobApplication[];
  jobApplicationsToDisplay: keyValue[];
  cvFileUrl?: string;
}

export interface Skills {
  _id: string;
  name: string;
}

export interface Option {
  label: string;
  value: string;
}

export interface NumericOption {
  label: string;
  value: number;
}

export interface NumericOrStringOption {
  label: string;
  value: number | string;
}


export interface GroupedOption {
  groupId: string,
  groupLabel: string, // Group name (e.g., "City", "District")
  options: NumericOrStringOption[];
}