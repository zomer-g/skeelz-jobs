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
    /** Marketing mail state (security/marketing.ts): agreed / not_agreed / removed / unknown. */
    marketing?: string;
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
    /** The roles this session carries (several per account since 23.11.2026; staff roles only on xhostd SSO). */
    userRoles?: string[];
    /** How the session was made (xhostd | email_code; 'password' on sessions from before 11.2026). Staff sessions must be xhostd (security/pure.ts). */
    via?: string;
}

export interface IAuthRequest extends Request {
    authJwtPayload: IAuthJwtPayload
}