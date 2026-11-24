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
import { getSignupFields } from '../services/settingsService.js';
import { checkValues as checkCustomValues, userMissingRequired } from '../services/customFieldsService.js';
import { NextFunction, Request, Response } from 'express';
import appConfig from '../config/appConfig.js';
import { microsoftConfig, xhostdConfig } from '../config/ssoConfig.js';
import { clearPasswordAfterSsoLink, findUserByEmail, findUserByMsSub, findUserBySsoSub, linkSsoSub } from '../dal/userDAL.js';
import { AuthErrorCodes, AuthErrorMessages, UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import IUser from '../models/schemas/user.js';
import { LoginResponse } from '../models/interfaces/general.interface.js';
import * as authService from '../services/authService.js';
import * as userService from '../services/userService.js';
import { writeAudit } from '../security/audit.js';
import { OidcError, randomToken, readFlow, sameValue, signFlow, verifyRs256, FLOW_COOKIE_SECONDS } from '../security/oidc.js';
import { isCandidate } from '../models/enums.js';
import { checkProfile, isStaffRole, isDbError, profileIncomplete, requestHost, safeErrorText, safeReturnPath, withQueryParam } from '../security/pure.js';
import { setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { loginActor } from './authController.js';
import { auditLogin, refusedAction, signinContext, signinFailed } from '../security/signins.js';
import { checkConsent } from '../security/consent.js';
import { emailCodeEnabled } from '../security/emailCode.js';
import { auditEmployerSignup, signUpEmployer, syncEmployerLater, wantsEmployer, withEmployerDetails } from '../services/employerAccounts.js';

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
// The same form serves "Continue with Microsoft" (controllers/microsoftSsoController.ts): `pv` says which identity
// the cookie holds ('microsoft'; absent = xhostd), so the new account is linked to the right column.
export type SsoProvider = 'xhostd' | 'microsoft';
const readSignup = (req: Request) => {
  const p = readFlow(SIGNUP_PROVIDER, req.cookies?.[SIGNUP_COOKIE]);
  const provider: SsoProvider = p?.pv === 'microsoft' ? 'microsoft' : 'xhostd';
  return p && p.sub && p.email
    ? { sub: String(p.sub), email: String(p.email), firstName: String(p.fn ?? ''), lastName: String(p.ln ?? ''), provider } : null;
};
const providerEnabled = (provider: SsoProvider) => (provider === 'microsoft' ? microsoftConfig().enabled : xhostdConfig().enabled);

/** Starts the sign-up form for a new, verified SSO identity (nothing is created yet). */
export const startSignup = (res: Response, returnPath: string, id: { sub: string; email: string; name: string; provider: SsoProvider }) => {
  const n = splitName(id.name);
  setSignupCookie(res, signFlow(SIGNUP_PROVIDER, {
    sub: id.sub, email: id.email, fn: n.firstName === '-' ? '' : n.firstName, ln: n.lastName === '-' ? '' : n.lastName,
    ...(id.provider === 'microsoft' ? { pv: 'microsoft' } : {}),
  }, SIGNUP_COOKIE_SECONDS));
  return res.redirect(302, withQueryParam(withQueryParam(returnPath, 'signin', 'signup'), 'via', viaOf(id.provider)));
};

/** `via` on the way back: which button was used, for the analytics `method` (google / microsoft). Not personal. */
export const viaOf = (provider: SsoProvider) => (provider === 'microsoft' ? 'microsoft' : 'google');

export const anon = (req: Request) => `anonymous:${req.ip}`;

/** Back to the page the visitor came from, with ?signin=ok or ?signin_error=<code> for the client to show. */
export const finish = (res: Response, returnPath: string, error?: string, provider: SsoProvider = 'xhostd') =>
  res.redirect(302, error ? withQueryParam(returnPath, 'signin_error', error)
    : withQueryParam(withQueryParam(returnPath, 'signin', 'ok'), 'via', viaOf(provider)));

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '-', lastName: parts.slice(1).join(' ') || '-' };
};

// ---------------------------------------------------------------------------
/** Which sign-in options the client shows. */
export const providers = (_req: Request, res: Response) => {
  const x = xhostdConfig();
  res.json({ data: { password: false, emailCode: emailCodeEnabled(), sso: x.enabled, ssoLogoutUrl: x.enabled ? x.logoutUrl : null, microsoft: microsoftConfig().enabled } });
};

/** The signed-in user (after a redirect sign-in the client has no login answer to read). */
export const session = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.authUser) return res.json({ data: null });
    const user = await userService.getUserById(req.authUser.id);
    if (!user) return res.json({ data: null });
    // The roles THIS session carries (req.authUser, from the DB and the sign-in method), not every role of the account.
    const roles = req.authUser.roles;
    const { password, ...cleanUser } = (await withEmployerDetails({ ...user, roles, role: req.authUser.role })) as any;
    const candidate = isCandidate({ roles });
    const jobApplicationsId = candidate ? await authService.jobApplicationsOf(req.authUser.id) : [];
    const response: LoginResponse & { profileIncomplete: boolean } = {
      jobApplicationsId, user: cleanUser, profileIncomplete: candidate && (profileIncomplete(user, await getSignupFields()) || await userMissingRequired(user)),
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
  let passwordCleared = false;
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
          signinFailed(req, loginActor(byEmail), 'auth.oauth_failed', byEmail, { provider: 'xhostd', reason: 'already_linked_other' });
          return finish(res, returnPath, 'link_conflict');
        }
        user = byEmail;
        void writeAudit(loginActor(byEmail), 'auth.sso_linked', null, { role: byEmail.role });
        // Pre-account takeover: someone may have registered this email with a password before its owner
        // came with Google. From now on the account is the Google identity's: the old password is cleared and
        // every earlier session closed (nobody but the owner can sign in). The owner is told on screen.
        if (await clearPasswordAfterSsoLink(String(byEmail._id))) {
          passwordCleared = true;
          void writeAudit(loginActor(byEmail), 'auth.sso_password_cleared', null, { role: byEmail.role, sessions_closed: true });
        }
      } else {
        // Nobody with this email: the sign-up form (a CANDIDATE, created only when the form is sent). SSO never
        // creates staff. Signed (HS256, our key), httpOnly, short-lived: the form can't claim another email.
        return startSignup(res, returnPath, { sub: claims.sub, email, name: String(claims.name ?? ''), provider: 'xhostd' });
      }
    }

    let s;
    try {
      s = await authService.issueSession(user, 'xhostd'); // refuses a deactivated account
    } catch (e) {
      if ((e as any)?.isAxiosError) {
        // Deactivated, or every role this session would carry blocked by an admin (24.11.2026).
        signinFailed(req, loginActor(user), refusedAction(e), user, { method: 'xhostd', role: user.role });
        return finish(res, returnPath, 'failed');
      }
      throw e;
    }
    setAccessTokenInCookies(res, s.accessToken);
    setRefreshTokenInCookies(res, s.refreshToken);
    auditLogin(req, user, 'xhostd', { staff: isStaffRole(user.role) });
    // The client shows a notice: sign in with Google from now on, or set a new password ("forgot password").
    return passwordCleared ? res.redirect(302, withQueryParam(withQueryParam(withQueryParam(returnPath, 'signin', 'ok'), 'via', 'google'), 'notice', 'password_cleared'))
      : finish(res, returnPath);
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
  res.json({ data: p && providerEnabled(p.provider) ? { email: p.email, firstName: p.firstName, lastName: p.lastName } : null });
};

/** The sign-up form after "Continue with Google": creates the candidate (linked, no password) and signs them in.
 *  With accountType: 'employer' the same form creates an EMPLOYER account instead (services/employerAccounts.ts). */
export const completeSignup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = readSignup(req);
    if (!p || !providerEnabled(p.provider)) {
      clearSignupCookie(res);
      return res.status(401).json({ message: AuthErrorMessages.SSO_SIGNUP_EXPIRED, code: AuthErrorCodes.SSO_SIGNUP_EXPIRED });
    }
    if (wantsEmployer(req.body)) {
      if (await (p.provider === 'microsoft' ? findUserByMsSub(p.sub) : findUserBySsoSub(p.sub))) {
        clearSignupCookie(res);
        return res.status(409).json({ message: AuthErrorMessages.USER_ALREADY_EXISTS, code: AuthErrorCodes.USER_ALREADY_EXISTS });
      }
      // Email from the signed cookie (the verified identity), never from the form; role always 'employer'.
      const r = await signUpEmployer(req.body, p.email, { sub: p.sub, provider: p.provider });
      if (!r.ok) return res.status(r.status).json(r.body);
      clearSignupCookie(res);
      const s = await authService.issueSession(r.user, p.provider);
      setAccessTokenInCookies(res, s.accessToken);
      setRefreshTokenInCookies(res, s.refreshToken);
      auditEmployerSignup(loginActor(r.user), String(r.user.id), p.provider, req.body?.marketingConsent === true, signinContext(req));
      auditLogin(req, r.user, p.provider, { staff: false });
      syncEmployerLater(String(r.user.id), loginActor(r.user));
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ data: { jobApplicationsId: [], user: r.user } });
    }
    const check = checkProfile(req.body, { requireAll: true, fields: await getSignupFields() });
    // The added sign-up fields (settings screen): every active required one answered, the rest checked.
    const extra = await checkCustomValues('signup', req.body?.customFields, { requireAll: true });
    if (!check.ok || !extra.ok) {
      const bad = [...(check.ok ? [] : check.bad), ...(extra.ok ? [] : extra.bad.map((id) => `customFields.${id}`))];
      return res.status(400).json({ message: UserErrorMessages.CREATE_USER_FAILED, code: UserErrorCodes.CREATE_USER_FAILED, fields: bad });
    }
    const consent = checkConsent(req.body, { needTerms: true, askMarketing: true });
    if (!consent.ok) return res.status(400).json({ message: 'Consent is required', code: consent.error });
    if (await (p.provider === 'microsoft' ? findUserByMsSub(p.sub) : findUserBySsoSub(p.sub))) {
      clearSignupCookie(res);
      return res.status(409).json({ message: AuthErrorMessages.USER_ALREADY_EXISTS, code: AuthErrorCodes.USER_ALREADY_EXISTS });
    }
    const v = check.values;
    // Email from the signed cookie (the verified SSO identity), never from the form; role is always 'user'.
    const dto: CreateUserDto = {
      email: p.email, firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber, citySymbol: v.citySymbol,
      gender: v.gender, dateOfBirth: v.dateOfBirth, idNumber: v.idNumber ?? null, skills: v.skills ?? [], cvFileUrl: v.cvFileUrl, hasAppliedToJob: false,
      customFields: extra.values,
    };
    const { user } = await userService.createUser(dto, { sso: { sub: p.sub, provider: p.provider }, consent: { marketing: consent.value.marketing === true } }); // email/phone taken → us2 / us3
    clearSignupCookie(res);
    const s = await authService.issueSession(user, p.provider);
    setAccessTokenInCookies(res, s.accessToken);
    setRefreshTokenInCookies(res, s.refreshToken);
    void writeAudit(loginActor(user), 'auth.signup_sso', String(user.id), {
      role: user.role, has_cv: !!user.cvFileUrl, marketing: consent.value.marketing === true, provider: p.provider, custom_fields: Object.keys(extra.values), ...signinContext(req),
    });
    auditLogin(req, user, p.provider, { staff: false });
    const { password, ...cleanUser } = user as any;
    const response: LoginResponse = { jobApplicationsId: [], user: cleanUser };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: response });
  } catch (e) {
    next(e);
  }
};
