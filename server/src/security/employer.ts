/* ============================================================================
 *  Employer accounts — pure rules (no DB, no Express). Unit-tested in
 *  server/test/unit/employer.test.ts. Owner's rules: docs/employers.md.
 *
 *  - The setting "employer job posting": 'open' (the anonymous /post-job form,
 *    as before — the default) or 'account_required' (only a signed-in employer).
 *  - An employer's own details (sign-up form, personal area).
 *  - Edit requests: which job fields an employer may ask to change, the
 *    validation (the same caps as the public form) and the old → new diff.
 * ========================================================================== */
import { cleanText, validateSubmission, FieldErrors, SubmissionInput } from '../services/jobSubmissionRules.js';
import { phoneOk } from './pure.js';

// ---- the setting ------------------------------------------------------------------------
export const EMPLOYER_POSTING_MODES = ['open', 'account_required'] as const;
export type EmployerPostingMode = typeof EMPLOYER_POSTING_MODES[number];
/** Today's behaviour when nothing is stored: the anonymous form stays open. */
export const DEFAULT_EMPLOYER_POSTING: EmployerPostingMode = 'open';
export const isEmployerPostingMode = (v: unknown): v is EmployerPostingMode =>
  typeof v === 'string' && (EMPLOYER_POSTING_MODES as readonly string[]).includes(v);
/** A stored value (jsonb { mode }) or anything else → a valid mode. */
export const normalizeEmployerPosting = (raw: unknown): EmployerPostingMode => {
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).mode : raw;
  return isEmployerPostingMode(m) ? m : DEFAULT_EMPLOYER_POSTING;
};

/**
 * May this caller send a job through POST /api/job-submissions?
 *   null            yes (anonymous or anyone in 'open'; a signed-in employer always)
 *   'sign_in'       'account_required' and nobody is signed in → 401
 *   'employer_only' 'account_required' and the caller is signed in with another kind of account → 403
 * `role` is the DB role of the caller (req.authUser), or null.
 */
export const postingRefusal = (mode: EmployerPostingMode, role: string | null | undefined): null | 'sign_in' | 'employer_only' => {
  if (role === 'employer') return null;
  if (mode === 'open') return null;
  return role ? 'employer_only' : 'sign_in';
};

// ---- an employer's own details ------------------------------------------------------------
export const EMPLOYER_PROFILE_FIELDS = ['firstName', 'lastName', 'companyName', 'phone', 'jobTitle'] as const;
export type EmployerProfileField = typeof EMPLOYER_PROFILE_FIELDS[number];
export const EMPLOYER_PROFILE_REQUIRED: readonly EmployerProfileField[] = ['firstName', 'lastName', 'companyName', 'phone'];
export const EMPLOYER_PROFILE_LIMITS = { name: { min: 2, max: 30 }, companyName: { min: 2, max: 80 }, jobTitle: { max: 60 } } as const;
export type EmployerProfile = { firstName: string; lastName: string; companyName: string; phone: string; jobTitle: string | null };
export type EmployerProfileCheck = { ok: true; values: Partial<EmployerProfile> } | { ok: false; bad: string[] };

/**
 * Checks an employer's own details. Unknown fields are dropped (allowlist: never email, role or anyone else's
 * record). `requireAll` (sign-up): every required field must be there. Returns field NAMES on failure.
 * The phone: an Israeli mobile or landline, digits only (the same rule as a candidate's).
 */
export const checkEmployerProfile = (body: unknown, opts: { requireAll?: boolean } = {}): EmployerProfileCheck => {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const values: Partial<EmployerProfile> = {};
  const bad: string[] = [];
  for (const f of EMPLOYER_PROFILE_FIELDS) {
    const raw = src[f];
    if (raw === undefined || raw === null || raw === '') {
      if (opts.requireAll && EMPLOYER_PROFILE_REQUIRED.includes(f)) bad.push(f);
      else if (f === 'jobTitle' && raw !== undefined) values.jobTitle = null;
      continue;
    }
    const s = cleanText(raw);
    switch (f) {
      case 'firstName': case 'lastName': {
        const L = EMPLOYER_PROFILE_LIMITS.name;
        if (s.length >= L.min && s.length <= L.max && !/\d/.test(s)) values[f] = s; else bad.push(f);
        break;
      }
      case 'companyName': {
        const L = EMPLOYER_PROFILE_LIMITS.companyName;
        if (s.length >= L.min && s.length <= L.max) values.companyName = s; else bad.push(f);
        break;
      }
      case 'phone': {
        const digits = s.replace(/[\s-]/g, '');
        if (phoneOk(digits)) values.phone = digits; else bad.push(f);
        break;
      }
      case 'jobTitle':
        if (s.length <= EMPLOYER_PROFILE_LIMITS.jobTitle.max) values.jobTitle = s || null; else bad.push(f);
        break;
    }
  }
  return bad.length ? { ok: false, bad } : { ok: true, values };
};

// ---- edit requests ------------------------------------------------------------------------
/** Fields an employer may ask to change on one of their published jobs (the public form's job fields; never the
 *  board settings, status, dates, internal comments or the apply policy — those stay with the content managers). */
export const EDITABLE_JOB_FIELDS = [
  'title', 'companyName', 'citySymbol', 'jobScope', 'requiredSkills', 'description', 'externalLink', 'publicEmail',
  'thresholdCondition',
] as const;
export type EditableJobField = typeof EDITABLE_JOB_FIELDS[number];
export type EditableJobValues = Pick<SubmissionInput, EditableJobField>;

/** Job description HTML → the plain text the employer edits (the form is plain text, like /post-job). */
export const htmlToPlainText = (html: unknown): string => {
  const s = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return cleanText(s, true);
};

/** A job as the employer sees and edits it (plain text). */
export const jobToEditable = (job: {
  title: string; companyName: string; citySymbol: number; jobScope?: string[]; requiredSkills?: string[];
  description: string; externalLink?: string | null; contactPersonEmail?: string | null; thresholdCondition?: string | null;
}): EditableJobValues => ({
  title: job.title,
  companyName: job.companyName,
  citySymbol: Number(job.citySymbol),
  jobScope: [...(job.jobScope ?? [])] as EditableJobValues['jobScope'],
  requiredSkills: [...(job.requiredSkills ?? [])],
  description: htmlToPlainText(job.description),
  externalLink: job.externalLink || null,
  publicEmail: job.contactPersonEmail || null,
  thresholdCondition: job.thresholdCondition || null,
});

const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? [...a].map(String).sort() : [];
    const y = Array.isArray(b) ? [...b].map(String).sort() : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return (a ?? null) === (b ?? null);
};

export type EditRequestCheck =
  | { ok: true; changes: Partial<EditableJobValues>; fields: EditableJobField[] }
  | { ok: false; errors: FieldErrors | { _: 'no_changes' | 'bad_field' }; badFields?: string[] };

/**
 * Validates an employer's edit request against the job as it is now. Only EDITABLE_JOB_FIELDS are accepted (any
 * other key → bad_field); each one with the public form's rules. Fields equal to the current value are dropped;
 * nothing left → no_changes. The result holds only the changed fields.
 */
export const checkEditRequest = (body: unknown, current: EditableJobValues): EditRequestCheck => {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const unknown = Object.keys(src).filter((k) => !(EDITABLE_JOB_FIELDS as readonly string[]).includes(k) && k !== 'note');
  if (unknown.length) return { ok: false, errors: { _: 'bad_field' }, badFields: unknown.slice(0, 10) };
  const given: Record<string, unknown> = {};
  for (const k of EDITABLE_JOB_FIELDS) if (k in src) given[k] = src[k];
  const { value, errors } = validateSubmission(given, { partial: true });
  if (Object.keys(errors).length) return { ok: false, errors };
  const changes: Partial<EditableJobValues> = {};
  for (const k of EDITABLE_JOB_FIELDS) {
    if (!(k in value)) continue;
    const v = (value as any)[k];
    if (!same(v, (current as any)[k])) (changes as any)[k] = v;
  }
  const fields = Object.keys(changes) as EditableJobField[];
  if (!fields.length) return { ok: false, errors: { _: 'no_changes' } };
  return { ok: true, changes, fields };
};

/** Per field: what the job had when asked (base), what it has now (current), what is asked (requested). */
export type FieldComparison = { field: EditableJobField; base: unknown; current: unknown; requested: unknown; changedSince: boolean };
export const compareEditRequest = (
  changes: Partial<EditableJobValues>, base: Partial<EditableJobValues>, current: EditableJobValues,
): FieldComparison[] =>
  EDITABLE_JOB_FIELDS.filter((f) => f in changes).map((f) => ({
    field: f,
    base: (base as any)[f] ?? null,
    current: (current as any)[f] ?? null,
    requested: (changes as any)[f] ?? null,
    changedSince: !same((base as any)[f], (current as any)[f]),
  }));

/** Edit-request changes → the job update (description back to safe HTML by the caller; publicEmail is the job's
 *  public application email, contactPersonEmail). */
export const changesToJobUpdate = (changes: Partial<EditableJobValues>, toHtml: (text: string) => string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'description') out.description = toHtml(String(v));
    else if (k === 'publicEmail') out.contactPersonEmail = v ?? null;
    else if (k === 'externalLink') out.externalLink = v ?? '';
    else out[k] = v;
  }
  return out;
};

// ---- claiming earlier anonymous submissions ---------------------------------------------------
/** A submission sent without an account may be claimed only by the account whose (verified) sign-in email is the
 *  submission's contact email, and only while nobody owns it. */
export const mayClaimSubmission = (s: { contactEmail: string; ownerId: string | null }, account: { id: string; email: string }): boolean =>
  !s.ownerId && !!account.email && s.contactEmail.trim().toLowerCase() === account.email.trim().toLowerCase();
