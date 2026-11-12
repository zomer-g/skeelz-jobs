/* ============================================================================
 *  "Continue with Google" = xhostd SSO, for everyone who doesn't use a password.
 *
 *  xhostd runs the Google sign-in at /xhost-auth/login (its own Google client;
 *  nothing for us to register) and sets an RS256-signed identity cookie,
 *  __Host-xhost_id, on our host. We check it (JWKS at auth.xhostd.com, issuer,
 *  aud = the host the request came in on, expiry) together with our own signed
 *  state cookie, then map the identity:
 *
 *    stored xhostd subject   → that account (staff or candidate)
 *    email of an account     → link the subject to it (staff or candidate), then sign in
 *    unknown                 → the SIGN-UP FORM: nothing is created yet. A signed, httpOnly, 20-minute
 *                              cookie (sso_signup: subject, email, name from the verified identity) is set
 *                              and the visitor lands on ?signin=signup; the form (same details as "new
 *                              user", email read-only, no password) posts to /auth/xhostd/signup, which
 *                              creates the candidate linked to the subject and signs them in. The email
 *                              comes only from that cookie, never from the form. Abandoned → nothing.
 *
 *  SSO never creates staff and never changes a role: staff exist beforehand in the
 *  DB (staff users screen) and are matched by subject or email. Staff may sign in
 *  ONLY this way (password and password reset are refused for staff); the session
 *  records `via: 'xhostd'`, which jwtAuthMiddleware requires for staff roles.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import appConfig from '../config/appConfig.js';
import { xhostdConfig } from '../config/ssoConfig.js';
import { findUserByEmail, findUserBySsoSub, linkSsoSub } from '../dal/userDAL.js';
import { AuthErrorCodes, AuthErrorMessages, UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import IUser from '../models/schemas/user.js';
import { LoginResponse } from '../models/interfaces/general.interface.js';
import * as authService from '../services/authService.js';
import * as userService from '../services/userService.js';
import { writeAudit } from '../security/audit.js';
import { OidcError, randomToken, readFlow, sameValue, signFlow, verifyRs256, FLOW_COOKIE_SECONDS } from '../security/oidc.js';
import { checkProfile, isStaffRole, isDbError, profileIncomplete, requestHost, safeErrorText, safeReturnPath, withQueryParam } from '../security/pure.js';
import { setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { loginActor } from './authController.js';

const FLOW_COOKIE = 'oidc_xhostd';
const FLOW_PATH = '/api/auth';
const FLOW_PROVIDER = 'xhostd';

const setFlowCookie = (res: Response, value: string) =>
  res.cookie(FLOW_COOKIE, value, {
    httpOnly: true,
    secure: !appConfig.isDevMode,
    // Lax: the callback is a top-level navigation coming back through Google and auth.xhostd.com.
    sameSite: 'lax',
    path: FLOW_PATH,
    maxAge: FLOW_COOKIE_SECONDS * 1000,
  });
const clearFlowCookie = (res: Response) =>
  res.clearCookie(FLOW_COOKIE, { httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'lax', path: FLOW_PATH });

// The pending sign-up of a new SSO identity (see the top of this file). Strict: only our own pages send it back.
const SIGNUP_COOKIE = 'sso_signup';
const SIGNUP_PROVIDER = 'xhostd_signup';
export const SIGNUP_COOKIE_SECONDS = 20 * 60;
const setSignupCookie = (res: Response, value: string) =>
  res.cookie(SIGNUP_COOKIE, value, {
    httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'strict', path: FLOW_PATH, maxAge: SIGNUP_COOKIE_SECONDS * 1000,
  });
const clearSignupCookie = (res: Response) =>
  res.clearCookie(SIGNUP_COOKIE, { httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'strict', path: FLOW_PATH });
const readSignup = (req: Request) => {
  const p = readFlow(SIGNUP_PROVIDER, req.cookies?.[SIGNUP_COOKIE]);
  return p && p.sub && p.email ? { sub: String(p.sub), email: String(p.email), firstName: String(p.fn ?? ''), lastName: String(p.ln ?? '') } : null;
};

const anon = (req: Request) => `anonymous:${req.ip}`;

/** Back to the page the visitor came from, with ?signin=ok or ?signin_error=<code> for the client to show. */
const finish = (res: Response, returnPath: string, error?: string) =>
  res.redirect(302, error ? withQueryParam(returnPath, 'signin_error', error) : withQueryParam(returnPath, 'signin', 'ok'));

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '-', lastName: parts.slice(1).join(' ') || '-' };
};

// ---------------------------------------------------------------------------
/** Which sign-in options the client shows. */
export const providers = (_req: Request, res: Response) => {
  const x = xhostdConfig();
  res.json({ data: { password: true, sso: x.enabled, ssoLogoutUrl: x.enabled ? x.logoutUrl : null } });
};

/** The signed-in user (after a redirect sign-in the client has no login answer to read). */
export const session = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.authUser) return res.json({ data: null });
    const user = await userService.getUserById(req.authUser.id);
    if (!user) return res.json({ data: null });
    const { password, ...cleanUser } = user as any;
    const jobApplicationsId = await authService.jobApplicationsOf(req.authUser.id);
    const response: LoginResponse & { profileIncomplete: boolean } = {
      jobApplicationsId, user: cleanUser, profileIncomplete: profileIncomplete(user),
    };
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: response });
  } catch (e) {
    next(e);
  }
};

export const ssoStart = (req: Request, res: Response) => {
  const returnPath = safeReturnPath(req.query.return_to);
  const cfg = xhostdConfig();
  if (!cfg.enabled) return finish(res, returnPath, 'disabled');
  const state = randomToken();
  setFlowCookie(res, signFlow(FLOW_PROVIDER, { s: state, r: returnPath }));
  const back = `/api/auth/xhostd/callback?state=${encodeURIComponent(state)}`;
  return res.redirect(302, `${cfg.loginUrl}?return_to=${encodeURIComponent(back)}`);
};

export const ssoCallback = async (req: Request, res: Response) => {
  const flow = readFlow(FLOW_PROVIDER, req.cookies?.[FLOW_COOKIE]);
  clearFlowCookie(res);
  const returnPath = safeReturnPath(flow?.r);
  const cfg = xhostdConfig();
  if (!cfg.enabled) return finish(res, returnPath, 'disabled');
  if (!flow || !sameValue(flow.s, req.query.state)) {
    void writeAudit(anon(req), 'auth.oauth_failed', null, { provider: 'xhostd', reason: 'state' });
    return finish(res, returnPath, 'state');
  }
  let email = '';
  try {
    // aud = the host this request came in on (platform host or a verified custom domain), never a fixed name.
    const claims = await verifyRs256(String(req.cookies?.[cfg.cookieName] ?? ''), {
      jwksUrl: cfg.jwksUrl, issuers: [cfg.issuer], audience: requestHost(req.headers.host),
    });
    email = String(claims.email ?? '').trim().toLowerCase();
    if (!email) throw new OidcError('no_email');

    let user: IUser | null = await findUserBySsoSub(claims.sub);
    if (!user) {
      const byEmail = await findUserByEmail(email);
      if (byEmail) {
        // First SSO sign-in of an existing account (staff or candidate): bind the subject to it.
        if (!(await linkSsoSub(String(byEmail._id), claims.sub))) {
          void writeAudit(loginActor(byEmail), 'auth.oauth_failed', null, { provider: 'xhostd', reason: 'already_linked_other' });
          return finish(res, returnPath, 'link_conflict');
        }
        user = byEmail;
        void writeAudit(loginActor(byEmail), 'auth.sso_linked', null, { role: byEmail.role });
      } else {
        // Nobody with this email: the sign-up form (a CANDIDATE, created only when the form is sent). SSO never
        // creates staff. Signed (HS256, our key), httpOnly, short-lived: the form can't claim another email.
        const n = splitName(String(claims.name ?? ''));
        setSignupCookie(res, signFlow(SIGNUP_PROVIDER, { sub: claims.sub, email, fn: n.firstName === '-' ? '' : n.firstName,
          ln: n.lastName === '-' ? '' : n.lastName }, SIGNUP_COOKIE_SECONDS));
        return res.redirect(302, withQueryParam(returnPath, 'signin', 'signup'));
      }
    }

    const s = await authService.issueSession(user, 'xhostd'); // refuses a deactivated account
    setAccessTokenInCookies(res, s.accessToken);
    setRefreshTokenInCookies(res, s.refreshToken);
    void writeAudit(loginActor(user), 'auth.login', null, { role: user.role, method: 'xhostd', staff: isStaffRole(user.role) });
    return finish(res, returnPath);
  } catch (e) {
    const reason = e instanceof OidcError ? e.reason : isDbError(e) ? 'db' : (e as any)?.isAxiosError ? 'refused' : 'error';
    if (!(e instanceof OidcError)) console.error(`[sso] callback failed: ${safeErrorText(e)}`);
    void writeAudit(anon(req), 'auth.oauth_failed', null, { provider: 'xhostd', reason });
    return finish(res, returnPath, reason === 'missing_token' ? 'no_sso_session' : 'failed');
  }
};

/** The pending SSO sign-up, to prefill the form (email read-only). Only the visitor's own cookie; null without it. */
export const pendingSignup = (req: Request, res: Response) => {
  const p = readSignup(req);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ data: p && xhostdConfig().enabled ? { email: p.email, firstName: p.firstName, lastName: p.lastName } : null });
};

/** The sign-up form after "Continue with Google": creates the candidate (linked, no password) and signs them in. */
export const completeSignup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = readSignup(req);
    if (!p || !xhostdConfig().enabled) {
      clearSignupCookie(res);
      return res.status(401).json({ message: AuthErrorMessages.SSO_SIGNUP_EXPIRED, code: AuthErrorCodes.SSO_SIGNUP_EXPIRED });
    }
    const check = checkProfile(req.body, { requireAll: true });
    if (!check.ok) {
      return res.status(400).json({ message: UserErrorMessages.CREATE_USER_FAILED, code: UserErrorCodes.CREATE_USER_FAILED, fields: check.bad });
    }
    if (await findUserBySsoSub(p.sub)) {
      clearSignupCookie(res);
      return res.status(409).json({ message: AuthErrorMessages.USER_ALREADY_EXISTS, code: AuthErrorCodes.USER_ALREADY_EXISTS });
    }
    const v = check.values;
    // Email from the signed cookie (the verified SSO identity), never from the form; role is always 'user'.
    const dto: CreateUserDto = {
      email: p.email, firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber, citySymbol: v.citySymbol,
      gender: v.gender, dateOfBirth: v.dateOfBirth, skills: v.skills ?? [], cvFileUrl: v.cvFileUrl, password: '', hasAppliedToJob: false,
    };
    const { user } = await userService.createUser(dto, { sso: { sub: p.sub } }); // email/phone taken → us2 / us3
    clearSignupCookie(res);
    const s = await authService.issueSession(user, 'xhostd');
    setAccessTokenInCookies(res, s.accessToken);
    setRefreshTokenInCookies(res, s.refreshToken);
    void writeAudit(loginActor(user), 'auth.signup_sso', String(user.id), { role: user.role, has_cv: !!user.cvFileUrl });
    void writeAudit(loginActor(user), 'auth.login', null, { role: user.role, method: 'xhostd', staff: false });
    const { password, ...cleanUser } = user as any;
    const response: LoginResponse = { jobApplicationsId: [], user: cleanUser };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: response });
  } catch (e) {
    next(e);
  }
};
