import { JobLocation } from './locations.js';
import { UserRole } from '../enums.js';

export interface JobApplication {
  jobId: string;
  date?: Date;
}

export interface IUser {
  _id: string;
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  dateOfBirth: Date | string;
  /** Only where it may be shown (userDAL.withIdNumber): never on the default user object. */
  idNumber?: string | null;
  gender: string;
  citySymbol: number;
  location?: Partial<JobLocation>;
  skills: string[];
  role: UserRole;
  /** Every role of the account (several since 23.11.2026); `role` is the highest. */
  roles?: UserRole[];
  cvFileUrl?: string;
  hasAppliedToJob: boolean;
  /** A candidate of the existing site (services/legacyCandidates.ts): 'mirror' = view only until the cutover. */
  legacyState?: 'mirror' | 'owned' | null;
}

export default IUser;
