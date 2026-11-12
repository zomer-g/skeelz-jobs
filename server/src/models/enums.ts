export enum JobStatus {
    ACTIVE = 'Active',
    SUSPENDED = 'Suspended',
    CLOSED = 'Closed'
}

/**
 * Separation of duties (docs/security.md):
 *   USER             a candidate: own details and applications only
 *   CONTENT_MANAGER  jobs and candidates (lists, applications, CVs); daily limits apply
 *   ADMIN            system and security: activity log, alerts, grants, reviews, staff users. Sees NO candidates.
 */
export enum UserRole {
    ADMIN = 'admin',
    CONTENT_MANAGER = 'content_manager',
    USER = 'user',
}

/** Roles of SKEELZ staff (logged by email, access-reviewed). */
export const STAFF_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.CONTENT_MANAGER];
export const isStaffRole = (role: string | undefined | null): boolean => STAFF_ROLES.includes(role as UserRole);

export enum JobScope {
    FULLTIME = 'FullTime',
    PARTIAL_TIME = 'PartialTime'
}

export enum CookieKey {
    ACCESS_TOKEN = 'access_token',
    REFRESH_TOKEN = 'refresh_token',
    PRE_OTP_TOKEN = 'pre_otp_token'
}

export enum HeaderKeys {
    AUTHORIZATION = 'authorization',
}

export enum TokenKey {
    REFRESH_TOKEN = 'refreshToken',
    ACCESS_TOKEN = 'accessToken',
    PRE_OTP_TOKEN = 'preotpToken',
}

export enum TokenType {
    RESET_PASSWORD = 'resetPassword',
    REFRESH_TOKEN = 'refreshToken',
}

export enum S3Folder {
    POST_SCAN = 'post-scan/',
}

export enum Files {
    CV_DEFAULT_NAME = 'cv.pdf',
}

export enum DayValues {
    TODAY = "today",
    ONE = "one",
    TWO = "two",
    THREE = "three",
    FOUR = "four",
    FIVE = "five",
    SIX = "six",
    SEVEN = "seven",
}

export enum StringBoolean {
    True = "true",
    False = "false",
  }
  
export enum CustomCitySymbol{
    WorkFromAnyPlace = -1,
    WorkFromHome = -2,
  }