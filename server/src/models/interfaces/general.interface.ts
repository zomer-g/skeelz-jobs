import IUser from "../schemas/user.js";

export interface AssociativeStringArray {
    [key: string]: string
}

export interface filterOptions {
    includeRandomSponsoredJobs?:boolean;
    jobScopeIds?: string[];
    jobCitySymbol?: number[];
    jobDistricts?: string[];
    jobSkillsIds?: string[];
    jobStatus?: string[];
    isSponsored?: boolean;
    /** Jobs-management filters (jobBoard.ts BoardFilters); ignored by public lists. */
    visibility?: 'public' | 'private';
    pinned?: boolean | string;
    archived?: 'only' | 'include';
    scheduled?: boolean | string;
    inputValue?: string;
    sortField?: string;
    sortOrder?: string;
    page?: number;
    limit?: number;
}

export interface usersFilter {
    inputValue?: string;
    sortField?: string | null;
    sortOrder?: string | null;
    page?: number;
    limit?: number;
    hasCv?: boolean;
    hasApplied?: boolean;
}

export interface Guest {
  _id:string;
  fullName: string;
  email: string;
  phoneNumber: string;
  cvFilePath?: string;
}

export interface LoginResponse {
    jobApplicationsId: string[] | null;
    // The tokens travel only in httpOnly cookies (they used to be in the body too,
    // which let any script on the page read them).
    user: Omit<IUser, 'password'>;
}

export interface IAuthJwtPayload {
    userID: string;
    userRole: string;
    /** How the session was made (password | xhostd). Staff sessions must be xhostd (security/pure.ts). */
    via?: string;
}

export interface IPasswordResetJwtPayload {
    userID: string;
    isPasswordUninitialized?: boolean;
}

export interface IAuthRequest extends Request {
    authJwtPayload: IAuthJwtPayload
}