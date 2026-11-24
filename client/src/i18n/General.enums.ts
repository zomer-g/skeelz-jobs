export enum RequestEnum {
    Get = 'GET',
    Post = 'POST',
    Put = 'PUT',
    Patch = 'PATCH',
    Delete = 'DELETE',
    Bearer = 'Bearer',
    String = 'string',
    XInitializedAt = 'X-Initialized-At',
    ErrorOnReq = 'Error on route request',
    ErrorConcat = ', error: ',
    ErrorBadRequest = 'Bad request',
}

export enum InputType {
  Text = 'text',
  Password = 'password'
}

export enum Direction {
  Rtl = 'rtl',
  Ltr = 'ltr'
}

export enum ResponseEnum {
    Undefined = 'undefined',
    Unauthorized = 'Unauthorized',
    Forbidden = 'forbidden',
    UnknownError = 'UnknownError',
    UnknownErrorMessage = 'An unexpected error occurred.',
}

export enum logTypes {
  info = 'info',
  warning = 'warning',
  error = 'error',
}

export enum CustomCitySymbol{
  WorkFromAnyPlace = -1,
  WorkFromHome = -2,
}

export enum DistrictsOptions {
  SOUTH = "ב\"ש והדרום",
  CENTER = "ת\"א והמרכז",
  NORTH = "חיפה וצפון",
  HEAD_OFFICE = "משרד ראשי",
  JERUSALEM = "ירושלים",
  NATIONWIDE = "כל הארץ",
}

export enum AllowedFileTypes {
  PDF = 'pdf',
  DOCX = 'docx',
}

export enum MessageColors{
  Primary = 'primary',
  Secondary = 'secondary',
  Success = 'success',
  Danger = 'danger',
  Warning = 'warning',
  Info = 'info',
  Light = 'light',
  Dark = 'dark'
}

export enum Gender{
  Male = 'male',
  Female = 'female',
  Other = 'other',
}

export enum Language {
  HEBREW = 'he',
  ENGLISH = 'en'
} 

export enum LocalizedDataKey {
  SKILLS = 'skills',
  JOB_SCOPE = 'jobScope',
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

export enum Colors {
  Alert = '#FF0400',
  Successful = '#039855',
  Pink = '#F4C8D8',
  PinkA = '#FAA7FF',
  Purple = '#A20068',
  Black = '#000',
  LightGrayA = '#EFEFEF',
  LightGrayB = '#717171',
  DarkGrayA = '#475467',
  DarkGrayB = '#52525B',
  DarkGrayC = '#5D5D5D',
  DarkGrayD = '#9A9A9A',
}
export interface StatusMessageState {
  message: string;
  isError: boolean;
}

// Roles (server/src/models/enums.ts): placement coordinators see candidates (view only) and manage jobs (no
// threshold condition, no apply settings); content managers do all that plus candidates' records, forwards and the
// job/candidate settings; admins can do all of that too, plus security, staff users and API keys.
export enum UserRole {
  ADMIN = 'admin',
  CONTENT_MANAGER = 'content_manager',
  PLACEMENT_COORDINATOR = 'placement_coordinator',
  USER = 'user',
  EMPLOYER = 'employer',
}

export const ROLE_LABELS: Record<string, string> = {
  admin: 'מנהל מערכת',
  content_manager: 'מנהל תוכן',
  placement_coordinator: 'רכז השמה',
  user: 'מועמד',
  employer: 'מעסיק',
};

/** An employer's account (docs/employers.md): its own area only — never candidates' or staff screens. */
export const isEmployerRole = (role?: string | null) => role === UserRole.EMPLOYER;

/** Where "אזור אישי" leads: an employer's area, else the candidate's applications. */
export const personalAreaRoute = (role?: string | null) =>
  role === UserRole.EMPLOYER ? '/employer' : '/job-Applications-management';

/* Several roles per account (owner, 23.11.2026): user.roles = the roles THIS session carries (the server leaves staff
 * roles out of a session not made with Google); user.role = the highest of them. */
type WithRoles = { role?: string | null; roles?: readonly string[] | null } | null | undefined;
export const rolesOfUser = (u: WithRoles): string[] => (u?.roles?.length ? [...u.roles] : u?.role ? [u.role] : []);
export const userHasRole = (u: WithRoles, r: UserRole): boolean => rolesOfUser(u).includes(r);
export const isCandidateUser = (u: WithRoles) => userHasRole(u, UserRole.USER);
export const isEmployerUser = (u: WithRoles) => userHasRole(u, UserRole.EMPLOYER);
/** The staff role of the session, or '' (at most one per account). */
export const staffRoleOfUser = (u: WithRoles): string =>
  rolesOfUser(u).find((r) => r === UserRole.ADMIN || r === UserRole.CONTENT_MANAGER || r === UserRole.PLACEMENT_COORDINATOR) ?? '';

/** Settings, candidates' records, forwards, threshold conditions, apply settings: content managers and admins. */
export const canManageContent = (role?: string | null) => role === UserRole.ADMIN || role === UserRole.CONTENT_MANAGER;

/** Jobs management and viewing candidates: placement coordinators, content managers and admins. */
export const canViewStaffData = (role?: string | null) => canManageContent(role) || role === UserRole.PLACEMENT_COORDINATOR;

export const isStaffRole = (role?: string | null) => canViewStaffData(role);

/** Staff roles that see jobs management and candidates (route guards). */
export const VIEWER_ROLES = [UserRole.PLACEMENT_COORDINATOR, UserRole.CONTENT_MANAGER, UserRole.ADMIN];

/** Where a staff member's management area starts. */
export const staffHomeRoute = (role?: string | null) =>
  role === UserRole.ADMIN ? '/security-management' : '/jobs-management';

export enum LocationGroupIds {
  City = 'city',
  District = 'district',
}

export enum DirectionTypeEnums {
  NEXT = "NEXT",
  PREV = "PREV"
}

export enum SortDirectionEnum {
  DESC = "desc",
  ASC = "asc"
}