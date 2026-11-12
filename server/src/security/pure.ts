/* ============================================================================
 *  Pure security decisions (no DB, no clock unless passed in) — unit-tested in
 *  server/test/security.test.mjs. The DB-bound code in this folder stays thin
 *  around these.
 * ========================================================================== */

/** Daily budgets per content manager (the only role that sees candidates). One place: the code, the refusal text, the admin
 *  screen and the privacy texts all read these numbers. */
export const LIMITS = {
  /** CV files opened (download or preview). */
  cvs: { daily: 40, alertAt: 20, grant: 40 },
  /** Candidates whose details were shown (each person once a day) or opened. */
  people: { daily: 1500, alertAt: 750, grant: 1500 },
} as const;
export type Budget = keyof typeof LIMITS;

/** Audit actions that spend each budget (sum of details.count since local midnight). */
export const BUDGET_ACTIONS: Record<Budget, readonly string[]> = {
  cvs: ['candidate.cv_opened'],
  people: ['candidates.shown', 'candidate.applications_viewed'],
};

/** Actions whose details.ids mark a candidate as "already seen today" by that content manager. */
export const SEEN_ACTIONS: readonly string[] = ['candidates.shown', 'candidate.applications_viewed', 'candidate.cv_opened'];

/** Activity log retention, quoted by the privacy texts. */
export const AUDIT_RETENTION_MONTHS = 24;

/** Employer job submissions (public form, /post-job): how long a submission and the employer's contact details
 *  are kept after it was approved or rejected (or after it was sent, if nobody reviewed it), and abuse limits. */
export const SUBMISSION_RETENTION_MONTHS = 12;
export const SUBMISSION_LIMITS = { perIpPerHour: 5, maxPending: 300 } as const;

/** Access reviews of staff (admins and content managers). */
export const REVIEW = { validDays: 60, remindDays: 10 } as const;

/** Roles an access review covers (everyone but candidates). */
export const REVIEWED_ROLES: readonly string[] = ['admin', 'content_manager'];
/** Roles an admin may assign. */
export const ASSIGNABLE_ROLES: readonly string[] = ['user', 'content_manager', 'admin'];

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

/** Masks emails and phone numbers inside free text (error messages, third-party replies). */
export const redactText = (s: string): string =>
  s.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');

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
 *  manager) sign in only with xhostd SSO ("Continue with Google"); candidates
 *  with a password or the same SSO. A new staff role joins REVIEWED_ROLES.
 * ------------------------------------------------------------------------- */
export const STAFF_ROLES: readonly string[] = REVIEWED_ROLES;
export const isStaffRole = (role: string | null | undefined): boolean => !!role && STAFF_ROLES.includes(role);

export type SignInMethod = 'password' | 'xhostd';
/** Is a session made with this method valid for this role? Checked on every request (jwtAuthMiddleware), with the
 *  role from the DB: staff only on an xhostd SSO session. Candidates on any (sessions from before `via` existed
 *  carry none; the xhostd flow never signs a candidate in). */
export const methodAllowedForRole = (method: string | null | undefined, role: string | null | undefined): boolean =>
  isStaffRole(role) ? method === 'xhostd' : true;

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
export const PROFILE_FIELDS = ['firstName', 'lastName', 'phoneNumber', 'citySymbol', 'gender', 'dateOfBirth', 'skills', 'cvFileUrl'] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];
/** Required to have a complete candidate profile (a new SSO candidate must give them all). */
export const PROFILE_REQUIRED: readonly ProfileField[] = ['firstName', 'lastName', 'phoneNumber', 'citySymbol', 'gender', 'dateOfBirth'];
export const GENDERS: readonly string[] = ['male', 'female', 'other'];

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
 * Checks a candidate's own details. Unknown fields are dropped (allowlist). With `requireAll` every field in
 * PROFILE_REQUIRED must be present; otherwise only the given ones are checked. Returns field NAMES on failure.
 */
export const checkProfile = (body: unknown, opts: { requireAll?: boolean; now?: Date } = {}): ProfileCheck => {
  const src = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const now = opts.now ?? new Date();
  const values: Partial<Record<ProfileField, any>> = {};
  const bad: string[] = [];
  for (const f of PROFILE_FIELDS) {
    const v = src[f];
    if (v === undefined || v === null || v === '') {
      if (opts.requireAll && PROFILE_REQUIRED.includes(f)) bad.push(f);
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

/** A candidate whose required details are missing (e.g. an account an earlier SSO sign-in created bare). */
export const profileIncomplete = (u: { role?: string | null; phoneNumber?: unknown; citySymbol?: unknown } | null | undefined): boolean =>
  !!u && u.role === 'user' && (!u.phoneNumber || !(Number(u.citySymbol) > 0));
