/* ============================================================================
 *  "Continue with Microsoft" — for CANDIDATES only. Staff sign in only with
 *  "Continue with Google" (xhostd SSO); this flow never signs staff in and never
 *  links a Microsoft identity to a staff account. OFF unless ENABLE_MICROSOFT_SSO
 *  (config/ssoConfig.ts microsoftConfig). Owner setup: docs/microsoft-sso.md.
 *
 *  OIDC authorization code + PKCE (S256) at login.microsoftonline.com/common/v2.0:
 *    start:    state, nonce, PKCE verifier and the redirect URI in a signed, httpOnly,
 *              10-minute cookie (oidc_microsoft, path /api/auth, SameSite=Lax: the
 *              callback is a top-level navigation back from Microsoft) → 302 to Microsoft.
 *    callback: state = cookie; code → token endpoint (client secret + verifier, server to
 *              server); ID token checked (security/microsoft.ts: RS256 / JWKS, issuer of
 *              its tenant, aud = our client id, exp, nonce); only a VERIFIED email counts.
 *  Mapping (same as xhostd SSO, candidates only):
 *    stored Microsoft key (users.ms_sub)  → that candidate
 *    email of a candidate                 → link the key to it (auth.sso_linked), clear an old password
 *    email of a staff-only account        → refused (staff_google_only); someone who is staff AND a
 *                                           candidate / employer signs in as that role only (no staff role
 *                                           on a Microsoft session; several roles per account since 23.11.2026)
 *    unknown                              → the same sign-up form as Google (nothing created yet)
 *  Only the Microsoft ID token is used; the access token is thrown away (no Graph calls).
 * ========================================================================== */
import { Request, Response } from 'express';
import appConfig from '../config/appConfig.js';
import { microsoftConfig } from '../config/ssoConfig.js';
import { clearPasswordAfterSsoLink, findUserByEmail, findUserByMsSub, linkMsSub } from '../dal/userDAL.js';
import IUser from '../models/schemas/user.js';
import * as authService from '../services/authService.js';
import { writeAudit } from '../security/audit.js';
import { OidcError, randomToken, readFlow, sameValue, signFlow, FLOW_COOKIE_SECONDS } from '../security/oidc.js';
import { microsoftIdentity, pkceChallenge, verifyMicrosoftIdToken } from '../security/microsoft.js';
import { hasNonStaffRole, isDbError, safeErrorText, safeReturnPath, withQueryParam } from '../security/pure.js';
import { rolesOf } from '../models/enums.js';
import { setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { loginActor } from './authController.js';
import { auditLogin, signinFailed } from '../security/signins.js';
import { anon, finish, startSignup } from './ssoController.js';

const FLOW_COOKIE = 'oidc_microsoft';
const FLOW_PATH = '/api/auth';
const FLOW_PROVIDER = 'microsoft';
export const CALLBACK_PATH = '/api/auth/microsoft/callback';
const TOKEN_TIMEOUT_MS = 10_000;

const setFlowCookie = (res: Response, value: string) =>
  res.cookie(FLOW_COOKIE, value, {
    httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'lax', path: FLOW_PATH, maxAge: FLOW_COOKIE_SECONDS * 1000,
  });
const clearFlowCookie = (res: Response) =>
  res.clearCookie(FLOW_COOKIE, { httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'lax', path: FLOW_PATH });

/** The redirect URI registered in Entra: MS_REDIRECT_URI, else built from this request's host. */
const redirectUriFor = (req: Request) => microsoftConfig().redirectUri || `${req.protocol}://${req.get('host')}${CALLBACK_PATH}`;

/** A failed / refused attempt; on a known account it carries details.account (and counts towards a staff burst). */
const failed = (req: Request, account: IUser | null, reason: string) => {
  if (account) signinFailed(req, loginActor(account), 'auth.oauth_failed', account, { provider: 'microsoft', reason });
  else void writeAudit(anon(req), 'auth.oauth_failed', null, { provider: 'microsoft', reason });
};

export const msStart = (req: Request, res: Response) => {
  const returnPath = safeReturnPath(req.query.return_to);
  const cfg = microsoftConfig();
  if (!cfg.enabled) return finish(res, returnPath, 'disabled');
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48); // 64 characters (PKCE: 43–128)
  const redirectUri = redirectUriFor(req);
  setFlowCookie(res, signFlow(FLOW_PROVIDER, { s: state, n: nonce, v: verifier, u: redirectUri, r: returnPath }));
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: cfg.scope,
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account', // a shared computer: always ask which account
  });
  return res.redirect(302, `${cfg.authorizeUrl}?${q.toString()}`);
};

/** code → ID token at Microsoft's token endpoint (server to server). Never logs the answer's body. */
const exchangeCode = async (code: string, verifier: string, redirectUri: string): Promise<string> => {
  const cfg = microsoftConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, code_verifier: verifier, scope: cfg.scope,
  });
  const r = await fetch(cfg.tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!r.ok) throw new OidcError(`token_http_${r.status}`);
  const json: any = await r.json().catch(() => null);
  if (typeof json?.id_token !== 'string') throw new OidcError('no_id_token');
  return json.id_token;
};

export const msCallback = async (req: Request, res: Response) => {
  const flow = readFlow(FLOW_PROVIDER, req.cookies?.[FLOW_COOKIE]);
  clearFlowCookie(res);
  const returnPath = safeReturnPath(flow?.r);
  const cfg = microsoftConfig();
  if (!cfg.enabled) return finish(res, returnPath, 'disabled');
  if (!flow || !sameValue(flow.s, req.query.state)) {
    failed(req, null, 'state');
    return finish(res, returnPath, 'state');
  }
  // The visitor cancelled at Microsoft, or Microsoft refused (e.g. the tenant's admin blocks the app).
  if (typeof req.query.error === 'string') {
    const code = /^[a-z_]{1,40}$/.test(req.query.error) ? req.query.error : 'other';
    failed(req, null, `provider_${code}`);
    return finish(res, returnPath, code === 'access_denied' ? 'cancelled' : 'failed');
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code || code.length > 4096) {
    failed(req, null, 'no_code');
    return finish(res, returnPath, 'failed');
  }
  let passwordCleared = false;
  try {
    const idToken = await exchangeCode(code, String(flow.v ?? ''), String(flow.u ?? ''));
    const claims = await verifyMicrosoftIdToken(idToken, {
      jwksUrl: cfg.jwksUrl, loginBase: cfg.loginBase, clientId: cfg.clientId, nonce: String(flow.n ?? ''),
    });
    const id = microsoftIdentity(claims);
    if (!id.ok) {
      failed(req, null, id.reason);
      return finish(res, returnPath, id.reason === 'unverified_email' ? 'ms_unverified_email' : 'failed');
    }

    let user: IUser | null = await findUserByMsSub(id.key);
    if (user && !hasNonStaffRole(rolesOf(user))) {
      // A staff-only account: staff use "Continue with Google" only. Someone who is staff AND a candidate or employer
      // signs in here as that candidate / employer only (security/pure.ts effectiveRoles: no staff role on this session).
      failed(req, user, 'staff');
      return finish(res, returnPath, 'staff_google_only');
    }
    if (!user) {
      const byEmail = await findUserByEmail(id.email);
      if (byEmail && !hasNonStaffRole(rolesOf(byEmail))) {
        failed(req, byEmail, 'staff');
        return finish(res, returnPath, 'staff_google_only');
      }
      if (byEmail) {
        if (!(await linkMsSub(String(byEmail._id), id.key))) {
          failed(req, byEmail, 'already_linked_other');
          return finish(res, returnPath, 'link_conflict');
        }
        user = byEmail;
        void writeAudit(loginActor(byEmail), 'auth.sso_linked', null, { role: byEmail.role, provider: 'microsoft' });
        // Same pre-account takeover rule as Google (ssoController): the account is now the verified identity's.
        if (await clearPasswordAfterSsoLink(String(byEmail._id))) {
          passwordCleared = true;
          void writeAudit(loginActor(byEmail), 'auth.sso_password_cleared', null, { role: byEmail.role, sessions_closed: true, provider: 'microsoft' });
        }
      } else {
        return startSignup(res, returnPath, { sub: id.key, email: id.email, name: id.name, provider: 'microsoft' });
      }
    }

    let s;
    try {
      s = await authService.issueSession(user, 'microsoft'); // refuses a deactivated account
    } catch (e) {
      if ((e as any)?.isAxiosError) {
        signinFailed(req, loginActor(user), 'auth.login_refused_deactivated', user, { method: 'microsoft', role: user.role });
        return finish(res, returnPath, 'failed');
      }
      throw e;
    }
    setAccessTokenInCookies(res, s.accessToken);
    setRefreshTokenInCookies(res, s.refreshToken);
    auditLogin(req, user, 'microsoft', { staff: false });
    return passwordCleared
      ? res.redirect(302, withQueryParam(withQueryParam(withQueryParam(returnPath, 'signin', 'ok'), 'via', 'microsoft'), 'notice', 'password_cleared_ms'))
      : finish(res, returnPath, undefined, 'microsoft');
  } catch (e) {
    const reason = e instanceof OidcError ? e.reason : isDbError(e) ? 'db' : 'error';
    if (!(e instanceof OidcError)) console.error(`[microsoft-sso] callback failed: ${safeErrorText(e)}`);
    failed(req, null, reason);
    return finish(res, returnPath, 'failed');
  }
};
