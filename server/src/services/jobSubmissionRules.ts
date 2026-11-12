/* ============================================================================
 *  Employer job submissions — pure rules (no DB): validation of the public form
 *  and the conversion of the plain-text description to safe HTML.
 *  Unit-tested in server/test/jobSubmission.test.mjs.
 *
 *  The public form takes PLAIN TEXT only. The description becomes HTML only at
 *  approval (escaped, then passed through sanitizeJobHtml like every job), so
 *  nothing an anonymous visitor types is ever rendered as markup.
 * ========================================================================== */
import { JobScope } from '../models/enums.js';
import { isObjectId } from '../utils/ids.js';
import { sanitizeJobHtml } from '../utils/sanitize.js';

/** Field caps. Title / company match the admin job form (the job card is sized for them). */
export const SUBMISSION_FIELD_LIMITS = {
  title: { min: 2, max: 30 },
  companyName: { min: 2, max: 28 },
  description: { min: 30, max: 5000 },
  externalLink: { max: 500 },
  publicEmail: { max: 254 },
  contactName: { min: 2, max: 70 },
  contactEmail: { max: 254 },
  contactPhoneDigits: { min: 9, max: 15 },
  requiredSkills: { min: 1, max: 15 },
  rejectReason: { max: 500 },
} as const;

/** Fields an employer sends (and staff may edit while the submission is pending). */
export const SUBMISSION_FIELDS = [
  'title', 'companyName', 'citySymbol', 'jobScope', 'requiredSkills', 'description', 'externalLink', 'publicEmail',
  'contactName', 'contactEmail', 'contactPhone',
] as const;
export type SubmissionField = typeof SUBMISSION_FIELDS[number];

export interface SubmissionInput {
  title: string;
  companyName: string;
  citySymbol: number;
  jobScope: JobScope[];
  requiredSkills: string[];
  description: string;
  externalLink: string | null;
  publicEmail: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

/** Error codes per field (the client shows its own localized text for each code). */
export type FieldErrors = Partial<Record<SubmissionField | 'consent', 'required' | 'too_short' | 'too_long' | 'invalid'>>;

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// Control characters (except tab/newline) and bidi overrides that could disguise text in the review screen.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

/** Trims, normalizes newlines and removes control characters. Non-strings become ''. */
export const cleanText = (v: unknown, keepNewlines = false): string => {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  if (!keepNewlines) s = s.replace(/\s+/g, ' ');
  else s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
};

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && u.hostname.includes('.');
  } catch { return false; }
};

/**
 * Validates a submission. `partial` (staff edits) checks only the fields present.
 * Returns the cleaned values and per-field error codes; any error → refuse.
 */
export const validateSubmission = (raw: any, opts: { partial?: boolean } = {}): { value: Partial<SubmissionInput>; errors: FieldErrors } => {
  const L = SUBMISSION_FIELD_LIMITS;
  const errors: FieldErrors = {};
  const value: Partial<SubmissionInput> = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  const has = (k: string) => !opts.partial || Object.prototype.hasOwnProperty.call(src, k);

  const text = (k: 'title' | 'companyName' | 'contactName', lim: { min: number; max: number }) => {
    if (!has(k)) return;
    const s = cleanText(src[k]);
    if (!s) errors[k] = 'required';
    else if (s.length < lim.min) errors[k] = 'too_short';
    else if (s.length > lim.max) errors[k] = 'too_long';
    else value[k] = s;
  };
  text('title', L.title);
  text('companyName', L.companyName);
  text('contactName', L.contactName);
  if (value.contactName && /\d/.test(value.contactName)) { delete value.contactName; errors.contactName = 'invalid'; }

  if (has('description')) {
    const s = cleanText(src.description, true);
    if (!s) errors.description = 'required';
    else if (s.length < L.description.min) errors.description = 'too_short';
    else if (s.length > L.description.max) errors.description = 'too_long';
    else value.description = s;
  }

  if (has('citySymbol')) {
    const n = Number(src.citySymbol);
    if (src.citySymbol === '' || src.citySymbol == null || !Number.isInteger(n) || n === 0) errors.citySymbol = 'required';
    else value.citySymbol = n;
  }

  if (has('jobScope')) {
    const arr = Array.isArray(src.jobScope) ? src.jobScope : [];
    const allowed = Object.values(JobScope) as string[];
    const scopes: string[] = Array.from(new Set(arr.map((x: unknown) => String(x))));
    if (!scopes.length) errors.jobScope = 'required';
    else if (scopes.some((s) => !allowed.includes(s))) errors.jobScope = 'invalid';
    else value.jobScope = scopes as JobScope[];
  }

  if (has('requiredSkills')) {
    const arr = Array.isArray(src.requiredSkills) ? src.requiredSkills : [];
    const ids: string[] = Array.from(new Set(arr.map((x: unknown) => String(x))));
    if (ids.length < L.requiredSkills.min) errors.requiredSkills = 'required';
    else if (ids.length > L.requiredSkills.max) errors.requiredSkills = 'too_long';
    else if (ids.some((id) => !isObjectId(id))) errors.requiredSkills = 'invalid';
    else value.requiredSkills = ids;
  }

  const email = (k: 'contactEmail' | 'publicEmail', required: boolean) => {
    if (!has(k)) return;
    const s = cleanText(src[k]).toLowerCase();
    if (!s) { if (required) errors[k] = 'required'; else (value as any)[k] = null; return; }
    if (s.length > L.contactEmail.max) errors[k] = 'too_long';
    else if (!EMAIL_RE.test(s)) errors[k] = 'invalid';
    else value[k] = s;
  };
  email('contactEmail', true);
  email('publicEmail', false);

  if (has('contactPhone')) {
    const s = cleanText(src.contactPhone);
    const digits = s.replace(/\D/g, '');
    if (!s) errors.contactPhone = 'required';
    else if (!/^\+?[\d\s-]+$/.test(s)) errors.contactPhone = 'invalid';
    else if (digits.length < L.contactPhoneDigits.min) errors.contactPhone = 'too_short';
    else if (digits.length > L.contactPhoneDigits.max) errors.contactPhone = 'too_long';
    else value.contactPhone = s;
  }

  if (has('externalLink')) {
    const s = cleanText(src.externalLink);
    if (!s) value.externalLink = null;
    else if (s.length > L.externalLink.max) errors.externalLink = 'too_long';
    else if (!isHttpUrl(s)) errors.externalLink = 'invalid';
    else value.externalLink = s;
  }

  if (!opts.partial && src.consent !== true) errors.consent = 'required';

  return { value, errors };
};

/** The honeypot field ("website") is hidden from people; a bot that fills it is dropped silently. */
export const isHoneypotHit = (raw: any): boolean =>
  !!raw && typeof raw === 'object' && typeof raw.website === 'string' && raw.website.trim() !== '';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

/** Plain text → job description HTML: escaped, paragraphs on blank lines, <br> on single newlines, then sanitized. */
export const descriptionToHtml = (text: string): string => {
  const paragraphs = cleanText(text, true).split(/\n{2,}/).filter(Boolean);
  const html = paragraphs.map((p) => `<p dir="auto">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  return sanitizeJobHtml(html);
};

/** Optional rejection reason: plain text, capped. */
export const cleanReason = (v: unknown): string | null => {
  const s = cleanText(v, true).slice(0, SUBMISSION_FIELD_LIMITS.rejectReason.max);
  return s || null;
};
