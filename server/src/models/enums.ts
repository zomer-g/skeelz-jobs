export enum JobStatus {
    ACTIVE = 'Active',
    SUSPENDED = 'Suspended',
    CLOSED = 'Closed'
}

/**
 * Separation of duties (docs/security.md):
 *   USER             a candidate: own details and applications only
 *   PLACEMENT_COORDINATOR  (רכז השמה, 11.2026) sees candidates, applications and CVs (view only, the same hand-overs
 *                    and limits) and manages jobs: create, edit, pin/bump, archive/restore, employer submissions
 *                    and edit requests. Never a threshold condition, a job's apply settings, a site setting,
 *                    a candidate's record or a forward to an employer.
 *   CONTENT_MANAGER  everything a coordinator does, plus candidates' records, forwards to employers, threshold
 *                    conditions, apply settings and the job/candidate settings (sign-up fields, apply policy,
 *                    employer posting); daily limits apply
 *   ADMIN            everything a content manager does, plus security: activity log, alerts, grants, reviews,
 *                    staff users, API tokens.
 *   EMPLOYER         an employer's account (since 11.2026): own job submissions, own published jobs, edit
 *                    requests for them. Never staff, never a candidate: sees no candidates, applications or CVs.
 */
export enum UserRole {
    ADMIN = 'admin',
    CONTENT_MANAGER = 'content_manager',
    PLACEMENT_COORDINATOR = 'placement_coordinator',
    USER = 'user',
    EMPLOYER = 'employer',
}

/** The employer role (gate employerOnly). Since 23.11.2026 one account may hold several roles (owner: a person can
 *  be a candidate, an employer and staff at once); each role keeps its own gate, hand-overs and limits. */
export const isEmployerRole = (role: string | undefined | null): boolean => role === UserRole.EMPLOYER;

/* ---------------------------------------------------------------------------
 *  Several roles per account (owner, 23.11.2026). users.roles is the set; users.role is DERIVED by a DB trigger
 *  (the primary role, ROLE_ORDER) so code that names a person by their highest role keeps working. At most one
 *  staff role per account (DB check). Staff roles count only on a Google (xhostd SSO) session: effectiveRoles.
 * ------------------------------------------------------------------------- */
export const ROLE_ORDER: readonly UserRole[] = [UserRole.ADMIN, UserRole.CONTENT_MANAGER, UserRole.PLACEMENT_COORDINATOR, UserRole.EMPLOYER, UserRole.USER];
/** The roles of an account row: users.roles, or [users.role] for a row read without it. Unknown names are dropped. */
export const rolesOf = (u: { roles?: readonly string[] | null; role?: string | null } | null | undefined): UserRole[] => {
  const raw = u?.roles?.length ? u.roles : u?.role ? [u.role] : [];
  return ROLE_ORDER.filter((r) => raw.includes(r));
};
/** The highest of a set of roles (what users.role holds), or '' for none. */
export const primaryRole = (roles: readonly string[]): UserRole | '' => ROLE_ORDER.find((r) => roles.includes(r)) ?? '';
export const hasRole = (u: { roles?: readonly string[] | null; role?: string | null } | null | undefined, r: UserRole): boolean =>
  rolesOf(u).includes(r);
export const isCandidate = (u: Parameters<typeof rolesOf>[0]): boolean => hasRole(u, UserRole.USER);
export const isEmployer = (u: Parameters<typeof rolesOf>[0]): boolean => hasRole(u, UserRole.EMPLOYER);

/** Roles that manage content: jobs, employer submissions, apply settings, candidates, applications, CVs.
 *  An admin can do everything a content manager can (owner's decision, 2026-11-12); a content manager stays
 *  content-only. Candidate data still goes through peopleHandover / cvHandover for both: limits, strict log, alerts. */
export const CONTENT_ROLES: readonly UserRole[] = [UserRole.CONTENT_MANAGER, UserRole.ADMIN];
export const canManageContent = (role: string | undefined | null): boolean => CONTENT_ROLES.includes(role as UserRole);

/** Roles that see jobs management and candidates (view only for a coordinator): coordinators, content managers,
 *  admins (gate staffViewers). Candidate data goes through peopleHandover / cvHandover for all of them. */
export const VIEWER_ROLES: readonly UserRole[] = [UserRole.PLACEMENT_COORDINATOR, UserRole.CONTENT_MANAGER, UserRole.ADMIN];
export const canViewStaffData = (role: string | undefined | null): boolean => VIEWER_ROLES.includes(role as UserRole);

/** Roles of SKEELZ staff (logged by email, access-reviewed, SSO only). */
export const STAFF_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.CONTENT_MANAGER, UserRole.PLACEMENT_COORDINATOR];
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