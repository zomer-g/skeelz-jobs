/* ============================================================================
 *  "Continue with Microsoft": checks of the ID token Microsoft returns, and the
 *  rule for which email we trust. Used by controllers/microsoftSsoController.ts.
 *
 *  ID token (from the token endpoint, after code + PKCE):
 *    - RS256 only, key from Microsoft's JWKS (security/oidc.ts verifyRs256);
 *    - issuer = https://login.microsoftonline.com/<tid>/v2.0 for the token's own
 *      tenant id (the `common` authority signs tokens for every tenant). The tid is
 *      read before the signature check ONLY to build the one issuer we then require;
 *      it decides nothing by itself (a forged tid fails the signature or the issuer);
 *    - audience = our client id; expiry; nonce = the one in our signed flow cookie.
 *
 *  Which email is verified (Microsoft: "don't use the email claim for authorization"
 *  unless you know it is verified; docs/microsoft-sso.md):
 *    - personal Microsoft account (tid 9188040d-…): the `email` claim. Microsoft
 *      accounts confirm their email address when created.
 *    - work / school account: the `email` claim ONLY when the token also says
 *      `xms_edov: true` ("email domain owner verified", an optional claim the owner
 *      turns on in Entra → Token configuration). Without it: refused.
 *    - `preferred_username` / `upn` are never used: an admin of any tenant can set
 *      them to any address.
 *  The account key is `<tid>:<sub>` (sub is stable per user for our app; never reused).
 * ========================================================================== */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OidcError, sameValue, verifyRs256 } from './oidc.js';

/** The tenant id Microsoft uses for every personal Microsoft account (outlook.com, hotmail.com, live.com …). */
export const PERSONAL_ACCOUNTS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTenantId = (v: unknown): v is string => typeof v === 'string' && GUID.test(v);

export const microsoftIssuer = (loginBase: string, tid: string) => `${loginBase.replace(/\/$/, '')}/${tid}/v2.0`;

/** Verifies a Microsoft ID token; returns its claims. Throws OidcError(reason). */
export const verifyMicrosoftIdToken = async (
  idToken: string,
  opts: { jwksUrl: string; loginBase: string; clientId: string; nonce: string },
): Promise<Record<string, any>> => {
  if (!idToken || !opts.clientId || !opts.nonce) throw new OidcError('missing_token');
  const unverifiedTid = (jwt.decode(idToken) as any)?.tid; // picks the expected issuer only; see the top of this file
  if (!isTenantId(unverifiedTid)) throw new OidcError('bad_tenant');
  const claims = await verifyRs256(idToken, {
    jwksUrl: opts.jwksUrl, issuers: [microsoftIssuer(opts.loginBase, unverifiedTid)], audience: opts.clientId,
  });
  if (claims.tid !== unverifiedTid) throw new OidcError('bad_tenant');
  if (Array.isArray(claims.aud) || claims.aud !== opts.clientId) throw new OidcError('bad_audience');
  if (!sameValue(claims.nonce, opts.nonce)) throw new OidcError('nonce');
  return claims;
};

export type MicrosoftIdentity =
  | { ok: true; key: string; email: string; name: string; personal: boolean }
  | { ok: false; reason: 'no_email' | 'unverified_email' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The account key and the VERIFIED email of verified claims (rule at the top of this file). */
export const microsoftIdentity = (claims: Record<string, any>): MicrosoftIdentity => {
  const tid = String(claims.tid ?? '');
  const personal = tid.toLowerCase() === PERSONAL_ACCOUNTS_TENANT;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !EMAIL.test(email) || email.length > 254) return { ok: false, reason: 'no_email' };
  if (!personal && !(claims.xms_edov === true || claims.xms_edov === 'true')) return { ok: false, reason: 'unverified_email' };
  return { ok: true, key: `${tid.toLowerCase()}:${String(claims.sub)}`, email, name: String(claims.name ?? ''), personal };
};

/** PKCE S256 challenge of a verifier. */
export const pkceChallenge = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');
