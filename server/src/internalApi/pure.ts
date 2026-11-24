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

/** Scopes that return people (candidates, applications) or CV files. Only admins issue keys at all
 *  (owner, 20.11.2026). salesforce:push is not one of them — it sends records to Salesforce and
 *  returns only record ids, Salesforce ids and status codes to the caller. */
export const PEOPLE_SCOPES: readonly Scope[] = ['candidates:read', 'applications:read', 'cvs:read'];

/** Scopes a staff member with this DB role may put on a new token: admins only (owner, 20.11.2026). A key
 *  whose issuer is no longer an admin is refused on use (issuerRefusal → issuer_role). */
export const issuableScopes = (role: string | undefined | null): Scope[] =>
  role === 'admin' ? [...ALL_SCOPES] : [];

/** Why a token whose issuer changed is refused on use, or null when the issuer still stands behind it:
 *  no issuer on record (legacy token), the issuer is deactivated, or the issuer's CURRENT DB role no longer
 *  allows every scope on the token (issuableScopes). */
export type IssuerRefusal = 'issuer_unknown' | 'issuer_inactive' | 'issuer_role';
export const issuerRefusal = (
  issuer: { role: string | null | undefined; deactivatedAt: Date | null | undefined } | null | undefined,
  scopes: readonly string[],
): IssuerRefusal | null => {
  if (!issuer || !issuer.role) return 'issuer_unknown';
  if (issuer.deactivatedAt) return 'issuer_inactive';
  const allowed = issuableScopes(issuer.role) as string[];
  return scopes.every((s) => allowed.includes(s)) ? null : 'issuer_role';
};

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

const OWN_CODES = new Set(['salesforce_disabled', 'imported_read_only', 'sf_no_content_version', 'sf_no_content_document',
  'not_found', 'location_not_found', 'cv_missing', 'beta_field_missing', 'employer_id_field_missing']);

/** What may be stored / logged about a failed Salesforce call: a short code, never a body. */
export const salesforceErrorCode = (e: any): string => {
  if (e && typeof e === 'object') {
    if (e.code === 'sf_not_found') return 'not_found';
    // Our own codes (services/salesforceService.ts, salesforceSync.ts).
    if (typeof e.code === 'string' && OWN_CODES.has(e.code)) return e.code;
    // config/salesforceConfig.ts: the OAuth error code only (invalid_client, invalid_grant…), never the body.
    if (e.name === 'SalesforceAuthError') return typeof e.code === 'string' && /^[A-Za-z0-9_]{3,40}$/.test(e.code) ? `auth_${e.code}` : 'auth';
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

/** Salesforce refused the login: every further call would fail too. */
export const isAuthErrorCode = (code: string | undefined) => code === 'auth' || !!code?.startsWith('auth_');
