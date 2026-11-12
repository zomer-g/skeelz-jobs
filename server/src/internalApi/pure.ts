/* ============================================================================
 *  Internal API — pure decisions (no DB, no clock unless passed in).
 *  Unit-tested in test/unit/internalApi.test.ts.
 * ========================================================================== */
import crypto from 'crypto';

/** What a token may do. The server secret has all of them. */
export const SCOPES = {
  'jobs:read': 'קריאת משרות (כולל לא פעילות והערות פנימיות)',
  'jobs:write': 'יצירה ועדכון של משרות',
  'applications:read': 'קריאת הגשות (נספר במגבלת המועמדים)',
  'candidates:read': 'קריאת פרטי מועמדים (נספר במגבלת המועמדים)',
  'cvs:read': 'הורדת קורות חיים (נספר במגבלת קורות החיים)',
  'salesforce:push': 'דחיפת משרות, הגשות ומועמדים ל-Salesforce',
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const isScope = (s: unknown): s is Scope => typeof s === 'string' && Object.prototype.hasOwnProperty.call(SCOPES, s);

/** Scopes that return people (candidates, applications) or CV files. Only a content manager may issue them:
 *  an admin sees no candidates, so cannot hand a system a key that does. salesforce:push is not one of them —
 *  it sends records to Salesforce and returns only record ids, Salesforce ids and status codes to the caller. */
export const PEOPLE_SCOPES: readonly Scope[] = ['candidates:read', 'applications:read', 'cvs:read'];

/** Scopes a staff member with this DB role may put on a new token. */
export const issuableScopes = (role: string | undefined | null): Scope[] =>
  role === 'content_manager' ? [...ALL_SCOPES] : role === 'admin' ? ALL_SCOPES.filter((s) => !PEOPLE_SCOPES.includes(s)) : [];

/** Token lifetime in days. */
export const TOKEN_DAYS = { default: 30, max: 90 } as const;

/** The actor written in the activity log for the server secret. */
export const SECRET_ACTOR = 'system:internal-api';
export const tokenActor = (prefix: string) => `token:${prefix}`;

/** The server secret must be long enough to be a secret; shorter = secret auth off. */
export const MIN_SECRET_LENGTH = 32;

// Token format: skzi_<8 hex>_<43 base64url>. The first part is the visible prefix.
const TOKEN_RE = /^(skzi_[0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** A new token: shown once; only its hash and prefix are stored. */
export const mintToken = (): { token: string; prefix: string; hash: string } => {
  const prefix = `skzi_${crypto.randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: sha256(token) };
};

/** The prefix of a well-formed token, else null (then it is not one of ours). */
export const tokenPrefix = (raw: string): string | null => TOKEN_RE.exec(raw)?.[1] ?? null;

/** `Authorization: Bearer <x>` → x, else null. */
export const bearerOf = (header: string | undefined): string | null => {
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header ?? '');
  return m ? m[1] : null;
};

/** Constant-time comparison of a presented value with the server secret (hashes are the same length). */
export const secretMatches = (given: string, secret: string | undefined): boolean => {
  if (!secret || secret.length < MIN_SECRET_LENGTH || !given) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(given), 'hex'), Buffer.from(sha256(secret), 'hex'));
};

/** Requested lifetime → whole days in [1, max]; missing → default. Anything else is an error. */
export const tokenDays = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return TOKEN_DAYS.default;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > TOKEN_DAYS.max) return null;
  return n;
};

/** Validated, de-duplicated scope list, or null when empty / unknown scopes. */
export const parseScopes = (v: unknown): Scope[] | null => {
  if (!Array.isArray(v) || !v.length) return null;
  if (!v.every(isScope)) return null;
  return ALL_SCOPES.filter((s) => v.includes(s));
};

export type TokenState = 'active' | 'expired' | 'revoked';
export const tokenState = (t: { expiresAt: Date; revokedAt: Date | null }, now = new Date()): TokenState =>
  t.revokedAt ? 'revoked' : t.expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';

/** Scopes required but not granted. */
export const missingScopes = (granted: readonly string[], required: readonly string[]): string[] =>
  required.filter((s) => !granted.includes(s));

/** What may be stored / logged about a failed Salesforce call: a short code, never a body. */
export const salesforceErrorCode = (e: any): string => {
  if (e && typeof e === 'object') {
    if (e.code === 'sf_not_found') return 'not_found';
    if (typeof e.message === 'string' && /authentication failed/i.test(e.message)) return 'auth';
    const status = e.response?.status;
    if (typeof status === 'number') {
      const sfCode = e.response?.data?.[0]?.errorCode;
      return typeof sfCode === 'string' && /^[A-Z_]{3,60}$/.test(sfCode) ? `http_${status}_${sfCode}` : `http_${status}`;
    }
    if (typeof e.code === 'string' && /^[A-Z_]{3,40}$/.test(e.code)) return `net_${e.code}`;
  }
  return 'error';
};
