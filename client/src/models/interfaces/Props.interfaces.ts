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
  isSelfApply: boolean;
  /** Admin override: null/undefined = inherit the site-wide default. */
  quickApplyOverride?: boolean | null;
  /** Admin override: null/undefined = inherit the site-wide default. */
  quickApplyWithoutCvOverride?: boolean | null;
  /** Effective policy for this job, computed by the server. */
  applyPolicy?: ApplyPolicy;
  jobAppcreatedAt?: Date;
  externalLink?: string;
  /** false = private (unlisted). Missing = public. */
  isPublic?: boolean;
  /** Pinned to the top of the board since; null = not pinned. */
  pinnedAt?: Date | string | null;
  /** Archived (soft-deleted) at; content managers only. */
  deletedAt?: Date | string | null;
  /** Sent with a future publishDate: scheduled publishing. Not stored. */
  schedulePublish?: boolean;
}

/** Whether guests may apply without registering, and whether they may skip the CV. */
export interface ApplyPolicy {
  quickApply: boolean;
  quickApplyWithoutCv: boolean;
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
  phoneNumber: string;
  citySymbol: number;
  password: string;
  confirmPassword?: string;
  skills?: string[];
  cvFileUrl?: string;
  hasAppliedToJob: boolean;
}

export interface guestApplyValues {
  email: string;
  fullName: string;
  phoneNumber: string;
  cvFilePath: string;
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
  jobApplicationsId: string[];
  cvFileUrl?: string;
}


export interface Guest {
  _id?:string;
  fullName: string;
  email: string;
  cvFilePath?: string;
}

export interface JobApplication {
  _id: string;
  jobId: string;
  date: Date;
  title?: string;
}

export interface ApplyJobButtonsProps {
  jobId: string;
  isSelfApply: boolean;
  /** Effective quick-apply policy for guests (defaults to on when unknown). */
  quickApply?: boolean;
  openDirectApplyModal: () => void;
  handleGuestApply: () => void;
}


export interface LoginFormValues {
  email: string;
  password: string;
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
  visibility?: 'public' | 'private';
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