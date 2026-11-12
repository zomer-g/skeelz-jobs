/* ============================================================================
 *  Token checks for xhostd SSO (no extra dependency): JWKS with key rotation,
 *  RS256-pinned verification, and a signed, short-lived cookie that carries the
 *  state between the start of a sign-in and its callback.
 * ========================================================================== */
import crypto, { KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import appConfig from '../config/appConfig.js';

const FETCH_TIMEOUT_MS = 5000;
const CACHE_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 5000;

export class OidcError extends Error {
  constructor(public reason: string) { super(`oidc: ${reason}`); this.name = 'OidcError'; }
}

const getJson = async (url: string): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new OidcError(`http_${res.status}`);
  return res.json();
};

// ---- JWKS ------------------------------------------------------------------
const jwksCache = new Map<string, { keys: Map<string, KeyObject>; at: number }>();
const fetchJwks = async (url: string) => {
  const body = await getJson(url);
  const keys = new Map<string, KeyObject>();
  for (const k of Array.isArray(body?.keys) ? body.keys : []) {
    if (k?.kty !== 'RSA' || !k.kid || (k.use && k.use !== 'sig') || (k.alg && k.alg !== 'RS256')) continue;
    try { keys.set(String(k.kid), crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* skip a bad key */ }
  }
  const entry = { keys, at: Date.now() };
  jwksCache.set(url, entry);
  return entry;
};
const keyFor = async (url: string, kid: string): Promise<KeyObject> => {
  let entry = jwksCache.get(url);
  const stale = !entry || Date.now() - entry.at > CACHE_MS;
  // An unknown kid means the provider rotated its keys: refetch (at most once every few seconds).
  if (stale || (!entry!.keys.has(kid) && Date.now() - entry!.at > REFETCH_MIN_MS)) entry = await fetchJwks(url);
  const key = entry!.keys.get(kid);
  if (!key) throw new OidcError('unknown_kid');
  return key;
};

/** Verifies a provider-signed JWT: RS256 only (the token's own `alg` never chooses), issuer, audience, expiry. */
export const verifyRs256 = async (token: string, opts: { jwksUrl: string; issuers: string[]; audience: string }): Promise<Record<string, any>> => {
  if (!token || !opts.audience) throw new OidcError('missing_token');
  const header = (jwt.decode(token, { complete: true }) as any)?.header; // header only: picks the key, decides nothing
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new OidcError('bad_header');
  const key = await keyFor(opts.jwksUrl, header.kid);
  let claims: Record<string, any>;
  try {
    claims = jwt.verify(token, key, {
      algorithms: ['RS256'],
      issuer: opts.issuers as [string, ...string[]],
      audience: opts.audience,
      clockTolerance: 30,
    }) as Record<string, any>;
  } catch (e) {
    throw new OidcError(e instanceof jwt.TokenExpiredError ? 'expired' : 'invalid_token');
  }
  if (typeof claims.exp !== 'number' || typeof claims.sub !== 'string' || !claims.sub) throw new OidcError('missing_claims');
  // jsonwebtoken accepts an aud LIST that contains the audience; we want exactly one audience (or azp = us).
  if (Array.isArray(claims.aud) && (claims.aud.length !== 1 && claims.azp !== opts.audience)) throw new OidcError('bad_audience');
  return claims;
};

// ---- random values ---------------------------------------------------
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sameValue = (a: unknown, b: unknown) => {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// ---- the short-lived flow cookie ------------------------------------------
const flowKey = () => crypto.createHmac('sha256', appConfig.accessTokenSecret || 'unset').update('oidc-flow-cookie/v1').digest();
export const FLOW_COOKIE_SECONDS = 10 * 60;

export const signFlow = (provider: string, data: Record<string, string>, ttlSeconds = FLOW_COOKIE_SECONDS) =>
  jwt.sign({ ...data }, flowKey(), { algorithm: 'HS256', expiresIn: ttlSeconds, audience: `flow:${provider}` });

export const readFlow = (provider: string, value: string | undefined): Record<string, string> | null => {
  if (!value) return null;
  try {
    return jwt.verify(value, flowKey(), { algorithms: ['HS256'], audience: `flow:${provider}` }) as Record<string, string>;
  } catch {
    return null;
  }
};
