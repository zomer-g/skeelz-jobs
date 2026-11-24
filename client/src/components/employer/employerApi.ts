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
