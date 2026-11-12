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
  gender: string;
  citySymbol: number;
  location?: Partial<JobLocation>;
  password: string;
  skills: string[];
  role: UserRole;
  cvFileUrl?: string;
  hasAppliedToJob: boolean;
}

export default IUser;
