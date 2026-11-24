// What may be sent to Google Analytics / Tag Manager — and nothing else.
//
// Pure module (no DOM, no imports) so server/test/analytics.test.ts can run it.
// Rule: NO personal data reaches Google. No names, emails, phone numbers, CV file
// names, free text (search box, job form fields), tokens or coordinates.
// Every event name and every parameter key is listed here; anything not listed is
// dropped, and every value must pass its own check or the parameter is dropped.
// docs/analytics.md lists the same events — keep both in step.

export type ApplyType = 'guest' | 'registered' | 'self_apply';
/** profile = the CV already on the profile; updated = a new file that replaces it; job_only = a file for this job only. */
export type CvChoice = 'profile' | 'updated' | 'job_only' | 'none';
export type ApplyMode = 'quick' | 'regular' | 'self';
export type FunnelSource = 'list' | 'map' | 'direct' | 'apply' | 'header';

type Check = (v: unknown) => boolean;

const oneOf = (...allowed: string[]): Check => (v) => typeof v === 'string' && allowed.includes(v);
const int = (min: number, max: number): Check => (v) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const bool: Check = (v) => typeof v === 'boolean';
// Ids/codes/field names: short, no spaces, no '@', not a phone-like run of digits.
const token = (max: number): Check => (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_.\-]+$/.test(v) && !/\d{7,}/.test(v);
// Job ids are 24-hex ObjectIds (server/src/utils/ids.ts) — nothing else gets through.
const jobId: Check = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/.test(v);
// Paths after sanitizePath(): only letters, digits, '/', '-', '_', ':'.
const path: Check = (v) => typeof v === 'string' && v.length <= 200 && /^\/[A-Za-z0-9/_:\-]*$/.test(v);
const url: Check = (v) => typeof v === 'string' && v.length <= 400 && /^https?:\/\/[^\s@]+$/.test(v) && !/\d{7,}/.test(v.replace(/\/job\/[a-f0-9]{24}/, ''));
const utm = token(100);
// Error codes: enum keys (UPPER_SNAKE) or the employer form's field codes. Never message text.
const LOWER_CODES = ['required', 'too_short', 'too_long', 'invalid', 'network', 'rate_limited', 'queue_full', 'server_error', 'unknown'];
/** Why an application did not go through (apiErrorCode() in analytics.ts maps the server's codes to these). */
export const APPLY_ERROR_CODES = ['threshold_not_confirmed', 'cv_required', 'already_applied', 'candidate_read_only', 'job_on_existing_site',
  'consent_needed', 'terms_not_accepted', 'employer_account', 'limit_reached', 'apply_failed'] as const;
// Internal API codes such as jb4 / au9 (two letters + digits) are codes, not text.
const errorCode: Check = (v) => typeof v === 'string' && v.length <= 60 && !/\d{7,}/.test(v) &&
  (/^[A-Z][A-Z0-9_]*$/.test(v) || LOWER_CODES.includes(v) || (APPLY_ERROR_CODES as readonly string[]).includes(v) || /^[a-z]{2}\d{1,3}$/.test(v));

/**
 * The apply funnel, in order. Every apply_* step event carries `step` (this number) and `step_name`, so a GA4
 * funnel exploration can use either the event names or step_name. Steps a job does not have (no threshold
 * condition, no terms question) are simply skipped. apply_abandon carries the furthest step reached.
 */
export const APPLY_STEPS = ['start', 'cv_step', 'cv_upload', 'cv_choice', 'threshold', 'threshold_confirmed',
  'terms', 'submit', 'success'] as const;
export type ApplyStepName = (typeof APPLY_STEPS)[number];
export const applyStepNumber = (name: ApplyStepName) => APPLY_STEPS.indexOf(name) + 1;
export const ABANDON_REASONS = ['dialog_closed', 'page_left', 'other_job'] as const;

/** A server error code → the analytics code for apply_error (null: not one we can name; use the message's key). */
export function applyErrorFromApiCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    jb11: 'cv_required', jb3: 'already_applied', jb4: 'apply_failed',
    threshold_not_confirmed: 'threshold_not_confirmed', candidate_read_only: 'candidate_read_only', job_on_existing_site: 'job_on_existing_site',
    consent_needed: 'consent_needed', terms_required: 'terms_not_accepted', marketing_required: 'terms_not_accepted',
    network: 'network',
  };
  if (Object.prototype.hasOwnProperty.call(known, code)) return known[code];
  if (code.startsWith('limit_')) return 'limit_reached';
  if (/^[a-z]{2}\d{1,3}$/.test(code)) return code;
  return null;
}

/** Form field NAMES that may be reported (never their values). */
export const APPLY_FIELDS = ['fullName', 'email', 'phoneNumber', 'cvFilePath'] as const;
/** Employer /post-job fields (branch claude/employer-job-form-c666b0, SubmissionFields.tsx FIELD_ORDER). */
export const POST_JOB_FIELDS = ['title', 'companyName', 'citySymbol', 'jobScope', 'requiredSkills', 'description',
  'externalLink', 'publicEmail', 'contactName', 'contactEmail', 'contactPhone', 'consent'] as const;
/** The employer form's sections, in page order (step 1..4). */
export const POST_JOB_STEPS = ['job', 'apply', 'contact', 'consent'] as const;
export const postJobStepOf = (field: string): { step: number; step_name: (typeof POST_JOB_STEPS)[number] } => {
  const i = (POST_JOB_FIELDS as readonly string[]).indexOf(field);
  const name = i < 6 ? 'job' : i < 8 ? 'apply' : i < 11 ? 'contact' : 'consent';
  return { step: POST_JOB_STEPS.indexOf(name) + 1, step_name: name };
};

/** Parameter key → value check. A key that is not here is never sent. */
export const PARAM_CHECKS: Readonly<Record<string, Check>> = {
  // context (added to every event by the helper)
  page_path: path,
  page_location: url,
  page_referrer: url,
  language: oneOf('he', 'en'),
  utm_source: utm,
  utm_medium: utm,
  utm_campaign: utm,
  utm_term: utm,
  utm_content: utm,
  // funnel
  job_id: jobId,
  apply_type: oneOf('guest', 'registered', 'self_apply'),
  cv_choice: oneOf('profile', 'updated', 'job_only', 'none'),
  apply_mode: oneOf('quick', 'regular', 'self'),
  has_threshold: bool,
  abandon_reason: oneOf(...ABANDON_REASONS),
  cv_required: bool,
  source: oneOf('list', 'map', 'direct', 'apply', 'header'),
  view: oneOf('list', 'map'),
  results_count: int(0, 100000),
  has_search_text: bool,
  filter_count: int(0, 1000),
  filter_scope_count: int(0, 1000),
  filter_location_count: int(0, 1000),
  filter_skill_count: int(0, 1000),
  radius_km: int(0, 1000),
  map_point_source: oneOf('city', 'map', 'geo'),
  error_code: errorCode,
  field_name: oneOf(...APPLY_FIELDS, ...POST_JOB_FIELDS),
  step: int(0, 50),
  step_name: oneOf(...POST_JOB_STEPS, ...APPLY_STEPS),
  file_type: oneOf('pdf', 'docx', 'other'),
  file_size_kb: int(0, 100000),
  method: oneOf('email_code', 'google', 'microsoft'),
  consent_analytics: bool,
  install_source: oneOf('footer', 'menu'),
  install_outcome: oneOf('accepted', 'dismissed', 'ios_help'),
};

/** Keys every apply-funnel event carries (set by applyFlow* in analytics.ts). */
const FLOW = ['job_id', 'apply_type', 'apply_mode', 'cv_required', 'has_threshold', 'cv_choice', 'step', 'step_name'] as const;

/** Event name → the keys it may carry (on top of the context keys). */
export const EVENTS = {
  page_view: [],
  // candidates
  job_list_view: ['results_count', 'view'],
  job_search: ['has_search_text', 'filter_count', 'filter_scope_count', 'filter_location_count', 'filter_skill_count', 'results_count'],
  map_search: ['radius_km', 'map_point_source', 'results_count', 'filter_count'],
  view_switch: ['view'],
  job_view: ['job_id', 'source', 'apply_type'],
  apply_click: ['job_id', 'apply_type', 'source'],
  apply_form_shown: ['job_id', 'apply_type', 'cv_required'],
  apply_validation_error: ['job_id', 'apply_type', 'field_name', 'error_code'],
  // the apply funnel (APPLY_STEPS; every one also carries FLOW keys: job, type, mode, CV rule, threshold, step)
  apply_start: [...FLOW],
  apply_cv_step: [...FLOW],
  apply_cv_upload_start: [...FLOW],
  apply_cv_upload: [...FLOW, 'file_type', 'file_size_kb'],
  apply_cv_upload_error: [...FLOW, 'error_code'],
  apply_cv_choice: [...FLOW],
  apply_threshold_shown: [...FLOW],
  apply_threshold_confirmed: [...FLOW],
  apply_threshold_dismissed: [...FLOW],
  apply_terms_shown: [...FLOW],
  apply_terms_declined: [...FLOW],
  apply_submit: [...FLOW],
  apply_success: [...FLOW],
  apply_error: [...FLOW, 'error_code'],
  apply_abandon: [...FLOW, 'abandon_reason'],
  login_prompt: ['job_id', 'source'],
  login: ['method', 'source', 'job_id'],
  sign_up_start: ['source', 'job_id'],
  sign_up: ['method', 'source', 'job_id'],
  // employers (public /post-job form)
  post_job_view: [],
  post_job_start: ['field_name'],
  post_job_step: ['step', 'step_name'],
  post_job_validation_error: ['field_name', 'step', 'error_code'],
  post_job_submit: [],
  post_job_success: [],
  post_job_error: ['error_code'],
  // staff (jobs-management screen): a job was published. Only its id.
  job_publish: ['job_id'],
  // consent
  consent_update: ['consent_analytics'],
  // the installable app (docs/pwa.md): the install option was used / the site was installed
  pwa_install_prompt: ['install_source', 'install_outcome'],
  pwa_installed: [],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENTS;
export type EventParams = Partial<Record<string, string | number | boolean | undefined | null>>;

export const CONTEXT_KEYS = ['page_path', 'page_location', 'page_referrer', 'language',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

/** Events to mark as key events (conversions) in GA4. */
export const KEY_EVENTS: EventName[] = ['apply_success', 'post_job_success', 'sign_up'];

const isEvent = (name: string): name is EventName => Object.prototype.hasOwnProperty.call(EVENTS, name);

/**
 * Returns the object to push, or null if the event is not on the list.
 * Unknown keys and values that fail their check are dropped silently.
 */
export function buildEvent(name: string, params: EventParams = {}): Record<string, string | number | boolean> | null {
  if (!isEvent(name)) return null;
  const allowed = new Set<string>([...EVENTS[name], ...CONTEXT_KEYS]);
  const out: Record<string, string | number | boolean> = { event: name };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!allowed.has(key)) continue;
    const check = PARAM_CHECKS[key];
    if (!check || !check(value)) continue;
    out[key] = value as string | number | boolean;
  }
  return out;
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const KEPT_QUERY = new Set<string>([...UTM_KEYS, 'view']);

/** Path with anything that is not a plain route segment collapsed (tokens, emails, odd text). */
export function sanitizePath(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean).map((s) => {
    let d = s;
    try { d = decodeURIComponent(s); } catch { /* keep raw */ }
    return /^[A-Za-z0-9_\-]{1,40}$/.test(d) && !/\d{7,}/.test(d.replace(/^[a-f0-9]{24}$/, '')) ? d : ':redacted';
  });
  return '/' + segs.join('/');
}

/**
 * The URL as Google may see it: origin + sanitized path + only utm_* and view.
 * Drops ?searchValue= (free text), ?token= (password reset) and everything else.
 */
export function sanitizeUrl(href: string): string {
  try {
    const u = new URL(href);
    const kept = new URLSearchParams();
    u.searchParams.forEach((value, key) => {
      if (KEPT_QUERY.has(key) && utm(value)) kept.set(key, value);
    });
    const qs = kept.toString();
    return `${u.origin}${sanitizePath(u.pathname)}${qs ? `?${qs}` : ''}`;
  } catch {
    return '';
  }
}

/** Referrer: origin only (another site's path/query may hold anything). */
export function sanitizeReferrer(ref: string): string {
  try { return ref ? new URL(ref).origin + '/' : ''; } catch { return ''; }
}

export function utmFrom(search: string): Partial<Record<(typeof UTM_KEYS)[number], string>> {
  const sp = new URLSearchParams(search);
  const out: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
  for (const k of UTM_KEYS) {
    const v = sp.get(k);
    if (v && utm(v)) out[k] = v;
  }
  return out;
}

/** Map a translated error message back to its code (the enum key), never the text. */
export function errorCodeFrom(message: unknown, dictionaries: Record<string, unknown>[]): string {
  if (typeof message !== 'string') return 'UNKNOWN';
  for (const dict of dictionaries) {
    for (const [key, value] of Object.entries(dict)) {
      if (value === message && /^[A-Za-z0-9_]{1,60}$/.test(key)) return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    }
  }
  return 'UNKNOWN';
}

export const fileTypeOf = (fileName: string): 'pdf' | 'docx' | 'other' => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'docx' : 'other';
};

// ---- consent -----------------------------------------------------------------
/** Cookies Google Analytics 4 sets (only after consent): _ga and _ga_<container id>. */
export const GA_COOKIE_NAME = /^_ga(_[A-Za-z0-9]+)?$/;
/** Their lifetime, set in the Google tag (cookie_expires): 395 days ≈ 13 months, renewed on each visit. */
export const GA_COOKIE_EXPIRES_SECONDS = 34128000;
export const GA_COOKIE_MONTHS = 13;
/** GA4 event-data retention the owner sets in GA4 (Admin → Data retention). Stated on /privacy. */
export const GA_RETENTION_MONTHS = 14;

export const CONSENT_STORAGE_KEY = 'skeelz_consent_v1';
/** Ask again after this many days. */
export const CONSENT_MAX_AGE_DAYS = 365;

export type ConsentChoice = { analytics: boolean; at: string };

export function parseConsent(raw: string | null, now: Date = new Date()): ConsentChoice | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (typeof c?.analytics !== 'boolean' || typeof c?.at !== 'string') return null;
    const at = new Date(c.at);
    if (Number.isNaN(at.getTime())) return null;
    if (now.getTime() - at.getTime() > CONSENT_MAX_AGE_DAYS * 86400000) return null;
    return { analytics: c.analytics, at: c.at };
  } catch {
    return null;
  }
}

/** Consent Mode v2 state for a choice. Ads are never granted — the site runs no ads. */
export function consentModeState(analytics: boolean) {
  return {
    analytics_storage: analytics ? 'granted' : 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  } as const;
}
