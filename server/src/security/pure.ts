/* ============================================================================
 *  Pure security decisions (no DB, no clock unless passed in) — unit-tested in
 *  server/test/security.test.mjs. The DB-bound code in this folder stays thin
 *  around these.
 * ========================================================================== */

/** Daily budgets. `cvs` / `people`: per staff member who sees candidates (content managers and admins).
 *  `employerCvs` / `employerPeople`: per employer account, for the applicants the SKEELZ team forwarded to them
 *  (docs/employers.md "Applicants"); their own budgets, never shared with staff, and no grants (grant 0).
 *  One place: the code, the refusal text, the admin screen and the privacy texts all read these numbers. */
export const LIMITS = {
  /** CV files opened (download or preview). */
  cvs: { daily: 40, alertAt: 20, grant: 40 },
  /** Candidates whose details were shown (each person once a day) or opened. */
  people: { daily: 1500, alertAt: 750, grant: 1500 },
  /** An employer: CVs of forwarded applicants opened. */
  employerCvs: { daily: 30, alertAt: 15, grant: 0 },
  /** An employer: forwarded applicants shown (each person once a day). */
  employerPeople: { daily: 200, alertAt: 100, grant: 0 },
} as const;
export type Budget = keyof typeof LIMITS;
/** Budgets an admin may top up for the day (staff only; an employer's limit is never raised). */
export const GRANTABLE_BUDGETS: readonly Budget[] = ['cvs', 'people'];
export const STAFF_BUDGETS: readonly Budget[] = ['cvs', 'people'];
export const EMPLOYER_BUDGETS: readonly Budget[] = ['employerCvs', 'employerPeople'];

/** Audit actions that spend each budget (sum of details.count since local midnight). */
export const BUDGET_ACTIONS: Record<Budget, readonly string[]> = {
  cvs: ['candidate.cv_opened'],
  people: ['candidates.shown', 'candidate.applications_viewed'],
  employerCvs: ['employer.cv_opened'],
  employerPeople: ['employer.applicants_shown'],
};

/** Actions whose details.ids mark a candidate as "already seen today" by that person (counted by actor / budget
 *  owner, so a staff member's and an employer's views never mix). */
export const SEEN_ACTIONS: readonly string[] = ['candidates.shown', 'candidate.applications_viewed', 'candidate.cv_opened',
  'employer.applicants_shown', 'employer.cv_opened'];

/* ---------------------------------------------------------------------------
 *  Employers see the applicants the SKEELZ team forwarded to them (owner's decision 11.2026, docs/employers.md):
 *  name + CV only, for a job they own, while the job is active and up to EMPLOYER_ACCESS_DAYS after it stopped
 *  being active (closed, suspended or removed from the board). Nothing is deleted when the window ends.
 * ------------------------------------------------------------------------- */
export const EMPLOYER_ACCESS_DAYS = 90;

/** Active = on the board: status Active and not removed (deleted_at). Private/scheduled jobs still count as active. */
export const jobIsActive = (j: { status: string; deletedAt?: Date | string | null }): boolean =>
  j.status === 'Active' && !j.deletedAt;

/** Until when an employer may see forwarded applicants of a job: null = no end (the job is active). `inactiveSince`
 *  is the moment the job stopped being active (job_inactive_since). A job that is not active and has no such moment
 *  is treated as closed long ago (no access). */
export const employerAccessUntil = (j: { status: string; deletedAt?: Date | string | null }, inactiveSince: Date | string | null | undefined): Date | null | 'closed' => {
  if (jobIsActive(j)) return null;
  if (!inactiveSince) return 'closed';
  return new Date(new Date(inactiveSince).getTime() + EMPLOYER_ACCESS_DAYS * 86400_000);
};
export const employerWindowOpen = (j: { status: string; deletedAt?: Date | string | null }, inactiveSince: Date | string | null | undefined, now: Date = new Date()): boolean => {
  const until = employerAccessUntil(j, inactiveSince);
  return until === null || (until !== 'closed' && until.getTime() > now.getTime());
};

/** Whether staff may cancel a forward: only while it is live and the employer has not been shown it yet. */
export const forwardCancelRefusal = (f: { cancelledAt: Date | string | null; firstSeenAt: Date | string | null } | null):
  null | 'forward_not_found' | 'forward_cancelled' | 'forward_seen' => {
  if (!f) return 'forward_not_found';
  if (f.cancelledAt) return 'forward_cancelled';
  if (f.firstSeenAt) return 'forward_seen';
  return null;
};

/** Activity log retention, quoted by the privacy texts. */
export const AUDIT_RETENTION_MONTHS = 24;

/** Employer job submissions (public form, /post-job): how long a submission and the employer's contact details
 *  are kept after it was approved or rejected (or after it was sent, if nobody reviewed it), and abuse limits. */
export const SUBMISSION_RETENTION_MONTHS = 12;
export const SUBMISSION_LIMITS = { perIpPerHour: 5, maxPending: 300 } as const;

/** Access reviews of staff (admins, content managers, placement coordinators). */
export const REVIEW = { validDays: 60, remindDays: 10 } as const;

/** Roles an access review covers (everyone but candidates). */
export const REVIEWED_ROLES: readonly string[] = ['admin', 'content_manager', 'placement_coordinator'];
/** Roles an admin may assign. */
export const ASSIGNABLE_ROLES: readonly string[] = ['user', 'placement_coordinator', 'content_manager', 'admin'];

export type StaffChange =
  | { kind: 'role'; to: string }
  | { kind: 'deactivate' };

/**
 * Lock-out rules for staff changes. Returns a refusal code, or null when allowed.
 *  - an unknown role is refused;
 *  - nobody deactivates themself;
 *  - the last ACTIVE admin can't lose the role or be deactivated (also not by themself).
 * `activeAdmins` counts active admins including the target when it is one.
 */
export const staffChangeRefusal = (opts: {
  actorId: string;
  target: { id: string; role: string; active: boolean };
  change: StaffChange;
  activeAdmins: number;
}): null | 'bad_role' | 'self_deactivate' | 'last_admin' | 'no_change' => {
  const { actorId, target, change, activeAdmins } = opts;
  if (change.kind === 'role' && !ASSIGNABLE_ROLES.includes(change.to)) return 'bad_role';
  if (change.kind === 'role' && change.to === target.role) return 'no_change';
  if (change.kind === 'deactivate' && target.id === actorId) return 'self_deactivate';
  if (change.kind === 'deactivate' && !target.active) return 'no_change';
  const losesAdmin = target.role === 'admin' && target.active && (change.kind === 'deactivate' || change.to !== 'admin');
  if (losesAdmin && activeAdmins <= 1) return 'last_admin';
  return null;
};

/**
 * Access tokens issued up to the second of a "revoke sessions" are refused (iat has 1 s resolution, so the
 * same second counts as before). A refused access token falls back to the refresh token, which the revoke
 * disabled too; a login made after the revoke still gets in through its own new refresh token.
 */
export const issuedBeforeRevoke = (iatSeconds: number | undefined, revokedAt: Date | null | undefined): boolean =>
  !!revokedAt && (typeof iatSeconds !== 'number' || iatSeconds <= Math.floor(revokedAt.getTime() / 1000));

const TZ = 'Asia/Jerusalem';

/** The business day (Israel time) of a moment, as YYYY-MM-DD. */
export const israelDay = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Offset of Israel time from UTC at a moment, in minutes (120 or 180). */
const israelOffsetMinutes = (d: Date): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - d.getTime()) / 60000);
};

/** The UTC instant of 00:00 Israel time on a YYYY-MM-DD day. */
export const israelMidnight = (day: string): Date => {
  const [y, m, dd] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, dd, 0, 0, 0));
  // Offset at that midnight (DST changes happen at 02:00, so the guess's offset is right).
  const off = israelOffsetMinutes(new Date(guess.getTime() - 3 * 3600_000));
  return new Date(guess.getTime() - off * 60000);
};

/** How much of a request fits in what is left today (never negative). */
export const allowance = (used: number, allowed: number, requested: number): number =>
  Math.max(0, Math.min(Math.max(0, requested), allowed - used));

/** True exactly when this spend crosses the alert line (used < alertAt <= used + n). */
export const crossesAlert = (used: number, n: number, alertAt: number): boolean =>
  n > 0 && used < alertAt && used + n >= alertAt;

/** Rows none of whose ids were already seen today (each person counts once a day). */
export const countNewRows = (rowIds: string[], seenToday: Iterable<string>): number => {
  const seen = new Set(seenToday);
  let n = 0;
  for (const id of new Set(rowIds)) if (id && !seen.has(id)) n++;
  return n;
};

/** Cap a list of ids for an audit entry; `more` tells the reader it was cut. */
export const capIds = (ids: string[], max = 1000): { ids: string[]; more_ids?: true } => {
  const unique = [...new Set(ids.filter(Boolean))];
  return unique.length > max ? { ids: unique.slice(0, max), more_ids: true } : { ids: unique };
};

export type ReviewState = 'never' | 'valid' | 'due_soon' | 'expired' | 'changed';

/** State of a staff member's access review. A role change since the review makes it due at once. */
export const reviewState = (
  review: { validUntil: Date; roleAtReview: string } | null,
  currentRole: string,
  now: Date = new Date()
): ReviewState => {
  if (!review) return 'never';
  if (review.roleAtReview !== currentRole) return 'changed';
  const left = review.validUntil.getTime() - now.getTime();
  if (left <= 0) return 'expired';
  if (left <= REVIEW.remindDays * 86400_000) return 'due_soon';
  return 'valid';
};

/** A confirmation holds validDays; renewing early adds them to the end of the current period. */
export const nextValidUntil = (current: Date | null, now: Date = new Date()): Date => {
  const base = current && current.getTime() > now.getTime() ? current : now;
  return new Date(base.getTime() + REVIEW.validDays * 86400_000);
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Israeli phone numbers and long digit runs (ids) that look like a person's number.
const PHONE_RE = /(?<![\w-])(?:\+?972[-\s]?|0)(?:[23489]|5\d|7\d)[-\s]?\d{3}[-\s]?\d{4}(?!\d)/g;

// An Israeli ID number (תעודת זהות): a standalone run of 8–9 digits (never inside an id such as a hex ObjectId).
const ID_NUMBER_RE = /(?<![\w-])\d{8,9}(?![\w-])/g;

/** Masks emails, phone numbers and ID numbers inside free text (error messages, third-party replies). */
export const redactText = (s: string): string =>
  s.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]').replace(ID_NUMBER_RE, '[id]');

/** A Postgres driver error (carries the SQL values in `detail`/`where`). */
export const isDbError = (e: any): boolean =>
  !!e && typeof e === 'object' && typeof e.code === 'string' && ('severity' in e || 'routine' in e) && /^[0-9A-Z]{5}$/.test(e.code);

/** What may be printed about an error: never DB values or third-party bodies. */
export const safeErrorText = (e: any): string => {
  if (isDbError(e)) return `database error (${e.code})`;
  if (e && typeof e === 'object' && e.isAxiosError) {
    const status = e.response?.status ? ` ${e.response.status}` : '';
    return `http error${status}${e.code ? ` (${e.code})` : ''}: ${redactText(String(e.message ?? ''))}`;
  }
  if (e instanceof Error) return `${e.name}: ${redactText(e.message)}`;
  return redactText(String(e));
};

/* ---------------------------------------------------------------------------
 *  Who may sign in how. ONE place: staff (the reviewed roles: admin, content
 *  manager, placement coordinator) sign in only with xhostd SSO ("Continue with Google"); candidates
 *  with a password or the same SSO. A new staff role joins REVIEWED_ROLES.
 * ------------------------------------------------------------------------- */
export const STAFF_ROLES: readonly string[] = REVIEWED_ROLES;
export const isStaffRole = (role: string | null | undefined): boolean => !!role && STAFF_ROLES.includes(role);

/** 'password': sessions made before 11.2026 only (password sign-in was removed); 'email_code': a code sent by email. */
export type SignInMethod = 'password' | 'xhostd' | 'microsoft' | 'email_code';
/** Is a session made with this method valid for this role? Checked on every request (jwtAuthMiddleware), with the
 *  role from the DB: staff only on an xhostd SSO session. Candidates on any (sessions from before `via` existed
 *  carry none). "Continue with Microsoft" ('microsoft') is for candidates only, so it never counts for staff. */
export const methodAllowedForRole = (method: string | null | undefined, role: string | null | undefined): boolean =>
  isStaffRole(role) ? method === 'xhostd' : true;

/**
 * Several roles per account (owner, 23.11.2026): the roles a session of this method actually carries. Each role
 * keeps its own rule: a staff role counts only on an xhostd SSO ("Continue with Google") session; candidate and
 * employer roles on any. So a candidate who is also a content manager and signs in by an emailed code (or with
 * Microsoft) is a candidate on that session, never staff. An empty result = no session (a staff-only account
 * signed in any other way).
 */
export const effectiveRoles = (roles: readonly string[], method: string | null | undefined): string[] =>
  roles.filter((r) => methodAllowedForRole(method, r));
/** Has the account any role that signs in without Google (candidate / employer)? Email code and Microsoft need one. */
export const hasNonStaffRole = (roles: readonly string[]): boolean => roles.some((r) => !isStaffRole(r));

/** A return path after an external sign-in: same-site absolute path only (no //host, no scheme, no backslash). */
export const safeReturnPath = (p: unknown, fallback = '/'): string => {
  const s = typeof p === 'string' ? p : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\u0000-\u001f]/.test(s) || s.length > 500) return fallback;
  if (s.startsWith('/api/') || s.startsWith('/xhost-auth/')) return fallback;
  return s;
};

/** Adds one query parameter to a path (keeps an existing query and #hash). */
export const withQueryParam = (path: string, key: string, value: string): string => {
  const [beforeHash, hash] = path.split('#', 2);
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash !== undefined ? `#${hash}` : ''}`;
};

/** The host a request came in on, as xhostd mints the identity cookie's aud: no port, lowercase. */
export const requestHost = (hostHeader: string | undefined): string => {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
};

/* ---------------------------------------------------------------------------
 *  A candidate's own details (sign-up from SSO, "complete your details", the
 *  personal area). Same rules as the sign-up form (client UserDetails.tsx).
 *  Only these fields can ever be set this way: never email, role, password or
 *  another person's record.
 * ------------------------------------------------------------------------- */
export const PROFILE_FIELDS = ['firstName', 'lastName', 'phoneNumber', 'citySymbol', 'gender', 'dateOfBirth', 'idNumber', 'skills', 'cvFileUrl'] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];
export const GENDERS: readonly string[] = ['male', 'female', 'other'];

/* ---------------------------------------------------------------------------
 *  Sign-up fields setting (admins, /security-management): for each field below
 *  whether the candidate MUST fill it, MAY fill it, or (ID number only) does
 *  not see it at all. First and last name are always required; email comes
 *  from the sign-in. The server enforces it (checkProfile), so the form can't
 *  skip a required field. Stored in app_settings 'signupFields'.
 * ------------------------------------------------------------------------- */
export const SIGNUP_FIELDS = ['phoneNumber', 'citySymbol', 'gender', 'dateOfBirth', 'idNumber'] as const;
export type SignupField = typeof SIGNUP_FIELDS[number];
export type SignupFieldMode = 'required' | 'optional' | 'hidden';
export type SignupFieldsSetting = Record<SignupField, SignupFieldMode>;
/** Today's form when nothing is stored: everything required as before; the ID number optional (owner, 11.2026). */
export const DEFAULT_SIGNUP_FIELDS: Readonly<SignupFieldsSetting> = Object.freeze({
  phoneNumber: 'required', citySymbol: 'required', gender: 'required', dateOfBirth: 'required', idNumber: 'optional',
});
/** 'hidden' only for the ID number: the other fields are part of every candidate's record. */
export const signupFieldModes = (f: SignupField): readonly SignupFieldMode[] =>
  f === 'idNumber' ? ['required', 'optional', 'hidden'] : ['required', 'optional'];
export const isSignupFieldMode = (f: string, v: unknown): boolean =>
  (SIGNUP_FIELDS as readonly string[]).includes(f) && (signupFieldModes(f as SignupField) as readonly unknown[]).includes(v);
/** A stored (or patched) value → a full, valid setting; unknown keys and bad values fall back to `base`. */
export const normalizeSignupFields = (raw: unknown, base: Readonly<SignupFieldsSetting> = DEFAULT_SIGNUP_FIELDS): SignupFieldsSetting => {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...base } as SignupFieldsSetting;
  for (const f of SIGNUP_FIELDS) if (isSignupFieldMode(f, src[f])) out[f] = src[f] as SignupFieldMode;
  return out;
};
/** The fields a candidate must give under this setting (names always). */
export const requiredProfileFields = (s: Readonly<SignupFieldsSetting> = DEFAULT_SIGNUP_FIELDS): ProfileField[] =>
  ['firstName', 'lastName', ...SIGNUP_FIELDS.filter((f) => s[f] === 'required')];
/** Required under the default setting (for callers without a setting). */
export const PROFILE_REQUIRED: readonly ProfileField[] = requiredProfileFields(DEFAULT_SIGNUP_FIELDS);

/**
 * Israeli ID number (תעודת זהות): 5–9 digits (shorter ones padded with zeros on the left), not all zeros, and the
 * check digit right (weights 1,2,1,2…, digits of each product summed, total divisible by 10). Returns the 9-digit
 * form, or null.
 */
export const normalizeIsraeliId = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^\d{5,9}$/.test(s)) return null;
  const id = s.padStart(9, '0');
  if (/^0+$/.test(id)) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0 ? id : null;
};

const nameOk = (v: unknown) => typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 30 && !/[0-9]/.test(v);
/** Israeli mobile (05x + 7 digits) or landline (02/03/04/08/09 + 7 digits), digits only. */
export const phoneOk = (v: unknown): boolean => {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return false;
  const stripped = v.replace(/^0+/, '');
  if (stripped.startsWith('5') && stripped.length === 9) return true;
  return /^(02|03|04|08|09)\d{7}$/.test(v);
};
const dateOk = (v: unknown, now: Date) => {
  if (typeof v !== 'string' && !(v instanceof Date)) return false;
  const d = new Date(v as any);
  if (Number.isNaN(d.getTime())) return false;
  const oldest = new Date(now); oldest.setFullYear(oldest.getFullYear() - 120);
  return d <= now && d >= oldest;
};

export type ProfileCheck = { ok: true; values: Partial<Record<ProfileField, any>> } | { ok: false; bad: string[] };

/**
 * Checks a candidate's own details. Unknown fields are dropped (allowlist). With `requireAll` every field the
 * setting requires (`fields`, default DEFAULT_SIGNUP_FIELDS) must be present; otherwise only the given ones are
 * checked. A field the setting hides is dropped. An empty ID number, when the setting doesn't require one and
 * `allowClear` is set (the personal area), clears it (values.idNumber = null). Returns field NAMES on failure.
 */
export const checkProfile = (
  body: unknown, opts: { requireAll?: boolean; now?: Date; fields?: Readonly<SignupFieldsSetting>; allowClear?: boolean } = {},
): ProfileCheck => {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const now = opts.now ?? new Date();
  const setting = opts.fields ?? DEFAULT_SIGNUP_FIELDS;
  const required = requiredProfileFields(setting);
  const values: Partial<Record<ProfileField, any>> = {};
  const bad: string[] = [];
  for (const f of PROFILE_FIELDS) {
    if (f === 'idNumber' && setting.idNumber === 'hidden') continue;
    const v = src[f];
    if (v === undefined || v === null || v === '') {
      if (opts.requireAll && required.includes(f)) bad.push(f);
      else if (f === 'idNumber' && v === '' && opts.allowClear && setting.idNumber !== 'required') values.idNumber = null;
      continue;
    }
    switch (f) {
      case 'firstName': case 'lastName':
        if (nameOk(v)) values[f] = String(v).trim(); else bad.push(f); break;
      case 'phoneNumber':
        if (phoneOk(v)) values[f] = v; else bad.push(f); break;
      case 'citySymbol': {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) values[f] = n; else bad.push(f); break;
      }
      case 'gender':
        if (typeof v === 'string' && GENDERS.includes(v)) values[f] = v; else bad.push(f); break;
      case 'dateOfBirth':
        if (dateOk(v, now)) values[f] = typeof v === 'string' ? v : (v as Date).toISOString(); else bad.push(f); break;
      case 'idNumber': {
        const id = normalizeIsraeliId(v);
        if (id) values[f] = id; else bad.push(f);
        break;
      }
      case 'skills':
        if (Array.isArray(v) && v.length <= 100 && v.every((s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s))) values[f] = v;
        else bad.push(f);
        break;
      case 'cvFileUrl':
        if (typeof v === 'string' && v.length <= 300) values[f] = v; else bad.push(f); break;
    }
  }
  return bad.length ? { ok: false, bad } : { ok: true, values };
};

/** A candidate whose required details are missing (e.g. an account an earlier SSO sign-in created bare): phone and
 *  town, each only while the setting requires it (the other fields were never checked here). */
export const profileIncomplete = (
  u: { role?: string | null; roles?: readonly string[] | null; phoneNumber?: unknown; citySymbol?: unknown } | null | undefined,
  fields: Readonly<SignupFieldsSetting> = DEFAULT_SIGNUP_FIELDS,
): boolean =>
  // Anyone holding the candidate role (several roles per account since 23.11.2026).
  !!u && (u.roles?.length ? u.roles.includes('user') : u.role === 'user') &&
  ((fields.phoneNumber === 'required' && !u.phoneNumber) || (fields.citySymbol === 'required' && !(Number(u.citySymbol) > 0)));

/* ---------------------------------------------------------------------------
 *  Sign-ins in the activity log (docs/security.md "Sign-ins"): every sign-in and sign-up entry carries the address
 *  (IP) and a short device summary (browser and OS family only, never the full user agent). Unusual sign-ins raise
 *  an alert on the admin security screen (security/signins.ts). The privacy texts quote these numbers.
 * ------------------------------------------------------------------------- */
export const SIGNIN_ALERTS = {
  /** Failed or refused sign-in attempts on ONE staff account within the window. */
  staffFailures: { count: 5, windowMinutes: 15 },
  /** Different accounts that signed in from ONE address within the window. */
  accountsPerAddress: { count: 10, windowMinutes: 60 },
} as const;

/** Failed / refused sign-in entries that count towards a staff account's burst (details.account or target = user:<id>). */
export const SIGNIN_FAILURE_ACTIONS: readonly string[] = ['auth.oauth_failed', 'auth.email_code_refused_staff', 'auth.email_code_limited',
  'auth.email_code_refused_deactivated', 'auth.login_refused_deactivated', 'auth.email_code_refused_blocked', 'auth.login_refused_blocked'];

/** The address as the log keeps it: IPv4-mapped IPv6 as plain IPv4, at most 64 characters, '' when unknown. */
export const normalizeIp = (ip: unknown): string => {
  const s = typeof ip === 'string' ? ip.trim() : '';
  if (!s) return '';
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return (v4 ? v4[1] : s).slice(0, 64);
};

/** Browser and OS family of a user agent ("Chrome · Windows"); never versions or the full string. */
export const deviceSummary = (ua: unknown): string => {
  const s = typeof ua === 'string' ? ua.slice(0, 1000) : '';
  if (!s.trim()) return 'unknown';
  if (/bot|crawl|spider|curl|wget|python|okhttp|postman|axios|^node$|undici|headless/i.test(s)) return 'script';
  const browser =
    /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
      : /OPR\/|Opera/.test(s) ? 'Opera'
        : /SamsungBrowser\//.test(s) ? 'Samsung Internet'
          : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
            : /Chrome\/|CriOS\/|Chromium\//.test(s) ? 'Chrome'
              : /Safari\//.test(s) && /Version\//.test(s) ? 'Safari'
                : 'other';
  const os =
    /Windows/.test(s) ? 'Windows'
      : /Android/.test(s) ? 'Android'
        : /iPhone|iPad|iPod/.test(s) ? 'iOS'
          : /CrOS/.test(s) ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(s) ? 'macOS'
              : /Linux/.test(s) ? 'Linux'
                : 'other';
  return `${browser} · ${os}`;
};

/** A staff sign-in from an address this account has not signed in from before. Only once the account HAS a history
 *  of addresses (entries from before addresses were logged carry none, so the first one after the change is not news). */
export const isNewSigninAddress = (ip: string, knownIps: Iterable<string>): boolean => {
  if (!ip) return false;
  const known = new Set([...knownIps].filter(Boolean));
  return known.size > 0 && !known.has(ip);
};

/** A burst: at least `limit` events (this one included) in the window. */
export const reachedBurst = (count: number, limit: number): boolean => limit > 0 && count >= limit;
