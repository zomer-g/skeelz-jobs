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

// Separation of duties (server/src/models/enums.ts): content managers handle jobs and candidates,
// admins handle security and staff users and see no candidates.
export enum UserRole {
  ADMIN = 'admin',
  CONTENT_MANAGER = 'content_manager',
  USER = 'user',
}

export const ROLE_LABELS: Record<string, string> = {
  admin: 'מנהל מערכת',
  content_manager: 'מנהל תוכן',
  user: 'מועמד',
};

export const isStaffRole = (role?: string | null) => role === UserRole.ADMIN || role === UserRole.CONTENT_MANAGER;

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