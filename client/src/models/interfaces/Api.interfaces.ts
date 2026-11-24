import { RawAxiosRequestHeaders, ResponseType } from "axios";
import { JobApplication, JobData, Skills, User, userProfile } from "./Props.interfaces";

export interface Params {
    [key: string]: any;
}

export interface Data {
    [key: string]: any;
}

export interface GetOptions {
    url: string;
    params?: Params;
    customHeaders?: RawAxiosRequestHeaders;
    additionalOptions?: {
        responseType?: ResponseType,
        returnWholeResponse?: boolean;
    }
}

export interface PostOptions {
    url: string;
    data: Data;
    customHeaders?: RawAxiosRequestHeaders
}

export interface ErrorResponse {
    code: string;
    message: string;
    error?: string;
    path?: string;
    statusCode?: number;
    timestamp?: string;
}

export interface CreateUserResponse {
    message: string,
    userId: string,
}

export interface CreateJobResponse {
    message: string,
}

export interface OnlyMessageResponse {
    message: string;
};

export interface ApplyJobResponse {
    message: string;
    jobApplicationId: string;
    /** 'profile' | 'job' | '' : which CV went with the application. */
    cvScope?: string;
    /** Set only when the profile CV was replaced during this application. */
    profileCvFileUrl?: string;
};

/** How the candidate chose the CV for an application (server: services/applicationCv.ts). */
export type ApplyCvChoice =
    | { mode: 'profile' }
    | { mode: 'replaceProfile' | 'jobOnly'; cvFilePath: string };

export interface MyCvResponse {
    cv: { fileName: string; uploadedAt: string | null } | null;
};

export interface GuestApplyJobResponse {
    message: string;
    userName?: string;
};

export interface ActiveJobsResponse {
    jobs: JobData[];
    total: number;
};

/** GET jobs/near: active jobs within a radius, nearest first. */
export interface NearbyJobsResponse {
    jobs: (JobData & { distanceKm: number })[];
    total: number;
    /** Matching jobs left out because their location has no coordinates. */
    withoutCoordinates: number;
    /** Remote / nationwide jobs (not on the map). */
    remote: number;
};

export interface GetAllJobsResponse {
    jobs: JobData[];
    total: number;
};
export interface GetUsersResponse {
    users: userProfile[];
    total: number;
};

export interface SkillsApiResponse {
    skills: Skills[];
  }
/** GET/PATCH /users/me: the signed-in candidate's own record and how they sign in. */
export interface MyProfile {
  user: any;
  hasPassword: boolean;
  ssoLinked: boolean;
  profileIncomplete: boolean;
  /** A candidate of the existing site before the cutover: details shown, not editable, no applying. */
  readOnly?: boolean;
  /** server/src/controllers/profileController.ts view(): the two consent boxes. */
  consent?: { termsCurrent: boolean; marketing: boolean | null; marketingAt: string | null };
}
