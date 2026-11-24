/* ============================================================================
 *  Sign-in by a one-time code sent by email (candidates only) — the pure part:
 *  numbers, hashing, the decisions. No DB, no clock unless passed in.
 *  Unit-tested in test/unit/emailCode.test.ts. The DB/HTTP part is
 *  controllers/emailSigninController.ts. Rules: docs/email-signin.md.
 *
 *  Stored per request (table email_codes): a keyed hash of the address
 *  (`emailKey`, never the address), a keyed hash of the code (`hashCode`, never
 *  the code), expiry, wrong tries, used. Rows are removed a day after they were
 *  made (they hold no candidate data).
 * ========================================================================== */
import crypto from 'crypto';

export const EMAIL_CODE = {
  digits: 6,
  /** A code is valid this long after it was sent. Quoted by the privacy texts and the email. */
  ttlMinutes: 10,
  /** Tries per code (right or wrong); then the code is dead and a new one must be requested. */
  maxAttempts: 5,
  /** A new code for the same address no sooner than this (the client's "send again" timer). */
  resendSeconds: 60,
  /** Codes per address. */
  perEmailPerHour: 5,
  perEmailPerDay: 10,
  /** Rows are deleted this long after they were made. */
  keepHours: 24,
} as const;

/**
 * The feature switch (owner, 11.2026): off until the sending domain is verified in Resend. Off → the routes answer
 * 503 `au18`, no code is made or sent, and the client shows the option greyed out. Turn on with
 * EMAIL_CODE_SIGNIN_ENABLED=true together with SEND_EMAIL_ENABLED, RESEND_API_KEY and EMAIL_FROM (docs/email-signin.md).
 */
export const emailCodeEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.EMAIL_CODE_SIGNIN_ENABLED === 'true';

const secret = (env: Record<string, string | undefined> = process.env) =>
  env.EMAIL_CODE_SECRET || env.RESET_TOKEN_SECRET || env.ACCESS_TOKEN_SECRET || 'skeelz-dev-only';

export const normalizeEmail = (v: unknown): string => String(v ?? '').trim().toLowerCase().slice(0, 400); // longer than any valid address: isValidEmail refuses it

/** The shape the sign-up forms accept (same as userService.createUser). */
export const isValidEmail = (email: string): boolean =>
  email.length >= 5 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** A keyed hash of the address: the same address gives the same key, the key does not give the address. */
export const emailKey = (email: string, env?: Record<string, string | undefined>): string =>
  crypto.createHmac('sha256', `${secret(env)}:email-code-address`).update(normalizeEmail(email)).digest('hex');

/** A keyed hash of the code, bound to the address (a code for one address is worthless for another). */
export const hashCode = (key: string, code: string, env?: Record<string, string | undefined>): string =>
  crypto.createHmac('sha256', `${secret(env)}:email-code`).update(`${key}:${code}`).digest('hex');

/** Six random digits (leading zeros kept), from the OS's CSPRNG. */
export const generateCode = (): string => String(crypto.randomInt(0, 10 ** EMAIL_CODE.digits)).padStart(EMAIL_CODE.digits, '0');

/** What a person typed → six digits, or null (spaces and dashes are forgiven). */
export const cleanCode = (v: unknown): string | null => {
  const s = String(v ?? '').replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${EMAIL_CODE.digits}}$`).test(s) ? s : null;
};

/** Constant-time comparison of two hex hashes. */
export const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export interface CodeRow { code_hash: string; expires_at: Date | string; attempts: number; used_at: Date | string | null }

export type CodeCheck = 'ok' | 'wrong' | 'expired' | 'used' | 'locked' | 'none';

/**
 * Decides one try against the newest code of the address. `attemptsBefore` is the count before this try (the DB
 * counts the try first, atomically, so parallel guesses can't exceed maxAttempts).
 */
export const checkCode = (row: CodeRow | null | undefined, typedHash: string, now: Date = new Date()): CodeCheck => {
  if (!row) return 'none';
  if (row.used_at) return 'used';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  if (row.attempts >= EMAIL_CODE.maxAttempts) return 'locked';
  return sameHash(row.code_hash, typedHash) ? 'ok' : 'wrong';
};

/** Tries left after a wrong one (attemptsAfter = the count including it). */
export const attemptsLeft = (attemptsAfter: number): number => Math.max(0, EMAIL_CODE.maxAttempts - attemptsAfter);

/**
 * May another code be sent to this address now? `recent` = the creation times of its codes in the last 24 hours.
 * Returns null (yes) or the seconds to wait. The same for every address, registered or not.
 */
export const requestRefusal = (recent: (Date | string)[], now: Date = new Date()): { retryAfterSeconds: number; reason: 'too_soon' | 'hourly' | 'daily' } | null => {
  const t = recent.map((d) => new Date(d).getTime()).filter(Number.isFinite).sort((a, b) => b - a);
  const n = now.getTime();
  const last = t[0];
  if (last !== undefined && n - last < EMAIL_CODE.resendSeconds * 1000) {
    return { retryAfterSeconds: Math.ceil((EMAIL_CODE.resendSeconds * 1000 - (n - last)) / 1000), reason: 'too_soon' };
  }
  const hour = t.filter((x) => n - x < 3600_000);
  if (hour.length >= EMAIL_CODE.perEmailPerHour) {
    return { retryAfterSeconds: Math.ceil((3600_000 - (n - hour[hour.length - 1])) / 1000), reason: 'hourly' };
  }
  const day = t.filter((x) => n - x < 86400_000);
  if (day.length >= EMAIL_CODE.perEmailPerDay) {
    return { retryAfterSeconds: Math.ceil((86400_000 - (n - day[day.length - 1])) / 1000), reason: 'daily' };
  }
  return null;
};

/** Why no code is sent to an address that exists (the answer to the visitor stays the same). An account with only
 *  staff roles gets none (staff sign in with Google only); one that also holds a candidate or employer role does: that
 *  session carries only those roles (pure.ts effectiveRoles, several roles per account since 23.11.2026). */
export const sendRefusal = (user: { role?: string | null; roles?: readonly string[] | null; deactivated?: boolean } | null, isStaff: (r: string | null | undefined) => boolean): 'staff' | 'deactivated' | null => {
  if (!user) return null;
  const roles = user.roles?.length ? user.roles : [user.role];
  if (roles.every((r) => isStaff(r))) return 'staff';
  if (user.deactivated) return 'deactivated';
  return null;
};

/** The one answer to "send me a code", for every address. */
export const NEUTRAL_REQUEST_ANSWER = 'If this address can sign in here, a code is on its way.';

/** The sign-in code email (Hebrew, RTL). Holds the code and nothing else about the person. */
export const signInCodeEmail = (code: string, siteUrl = ''): { subject: string; text: string } => ({
  subject: `קוד הכניסה שלך לסקילז: ${code}`,
  text: `שלום,

קוד הכניסה שלך ללוח המשרות של סקילז הוא:
${code}

הקוד בתוקף ${EMAIL_CODE.ttlMinutes} דקות ואפשר להשתמש בו פעם אחת בלבד.
אם לא ביקשת להיכנס${siteUrl ? ` ל-${siteUrl}` : ''}, אפשר להתעלם מההודעה. אף אחד לא יוכל להיכנס בלי הקוד.

צוות סקילז`,
});
