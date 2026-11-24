// Small fetch helper for the employer area and the staff queue (same as JobSubmissionsReview): JSON in and out,
// cookies sent, errors carry the server's message, code and per-field codes.
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public fields?: Record<string, string> | string[]) {
    super(message);
  }
}

export const api = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.message || `HTTP ${res.status}`, res.status, body.code, body.fields);
  return body.data as T;
};

export type EditableValues = {
  title: string; companyName: string; citySymbol: number; jobScope: string[]; requiredSkills: string[];
  description: string; externalLink: string | null; publicEmail: string | null; thresholdCondition: string | null;
  /** Since 24.11.2026 (every field of a job, after staff approve): the job's public contact, status, apply settings. */
  contactPersonName?: string | null; contactPersonPhone?: string | null; status?: string;
  guestModeOverride?: string | null; quickCvOverride?: string | null; regularCvOverride?: string | null;
};

/** The job fields of an edit request that the public form doesn't have ('' = empty / the site's default). */
export type JobExtraValues = {
  contactPersonName: string; contactPersonPhone: string; status: string;
  guestModeOverride: string; quickCvOverride: string; regularCvOverride: string;
};
export const JOB_EXTRA_FIELDS = ['contactPersonName', 'contactPersonPhone', 'status', 'guestModeOverride', 'quickCvOverride', 'regularCvOverride'] as const;
export const extraOf = (v: EditableValues): JobExtraValues => ({
  contactPersonName: v.contactPersonName ?? '', contactPersonPhone: v.contactPersonPhone ?? '', status: v.status ?? 'Active',
  guestModeOverride: v.guestModeOverride ?? '', quickCvOverride: v.quickCvOverride ?? '', regularCvOverride: v.regularCvOverride ?? '',
});
/** Labels and values of those fields, for the employer's list and the staff review (Hebrew). */
export const extraLabel = (k: string, ap: { GuestModeLabel: string; QuickCvLabel: string; RegularCvLabel: string }): string | undefined => (({
  contactPersonName: 'איש/אשת קשר במשרה', contactPersonPhone: 'טלפון איש/אשת הקשר', status: 'מצב המשרה',
  guestModeOverride: ap.GuestModeLabel, quickCvOverride: ap.QuickCvLabel, regularCvOverride: ap.RegularCvLabel,
} as Record<string, string>)[k]);
export const STATUS_LABELS: Record<string, string> = { Active: 'פעילה', Suspended: 'מושהית', Closed: 'סגורה' };
export const extraValueText = (k: string, v: unknown, ap: { ModeSelf: string; ModeQuick: string; ModeNone: string; CvRequired: string; CvOptional: string; Inherit: string }): string | undefined => {
  if (k === 'status') return STATUS_LABELS[String(v)] ?? String(v ?? '—');
  if (k === 'guestModeOverride') return v == null || v === '' ? ap.Inherit : ({ self: ap.ModeSelf, quick: ap.ModeQuick, none: ap.ModeNone } as Record<string, string>)[String(v)] ?? String(v);
  if (k === 'quickCvOverride' || k === 'regularCvOverride') return v == null || v === '' ? ap.Inherit : v === 'required' ? ap.CvRequired : v === 'optional' ? ap.CvOptional : String(v);
  return undefined;
};

export const fmtDate = (s: string | null | undefined, withTime = false) =>
  (s ? (withTime ? new Date(s).toLocaleString('he-IL') : new Date(s).toLocaleDateString('he-IL')) : '—');

/** Remembers that the visitor came from an employer button (/post-job, the employer area), so a NEW account becomes
 *  an employer account. Everyone else who signs up is a candidate (there is no "employer or job seeker?" screen since
 *  11.2026). Per tab only (it survives the Google / Microsoft redirect); harmless if storage is blocked. */
const KEY = 'skeelz_signup_as';
export const rememberEmployerSignup = () => { try { sessionStorage.setItem(KEY, 'employer'); } catch { /* ignore */ } };
let employerLoginRequested = false;
/** Opens the sign-in window as an employer (the employer buttons only). */
export const openEmployerLogin = (open: () => void) => { rememberEmployerSignup(); employerLoginRequested = true; open(); };
/** The sign-in window is opening: true when an employer button asked for it (once). Any other opening — the header's
 *  "התחברות", applying for a job, a guarded page — is a candidate's, so the employer choice is forgotten. */
export const takeEmployerLoginRequest = (): boolean => {
  const asked = employerLoginRequested;
  employerLoginRequested = false;
  if (!asked) forgetSignupPreference();
  return asked;
};
export const signupPrefersEmployer = (): boolean => { try { return sessionStorage.getItem(KEY) === 'employer'; } catch { return false; } };
export const forgetSignupPreference = () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } };
