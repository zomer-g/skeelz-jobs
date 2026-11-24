/* ============================================================================
 *  "קבלת קוד למייל": candidates sign in with a one-time code sent by email
 *  (Resend, services/emailService.ts). Rules: docs/email-signin.md; the pure
 *  part (numbers, hashes, decisions) is security/emailCode.ts.
 *
 *  POST /api/auth/email/request {email}
 *    Always the same 200 answer (registered or not, candidate or staff), sent
 *    before any email goes out, so neither the text nor the time says whether
 *    an account exists. A code is sent to a new address (that is sign-up) and
 *    to an account holding a candidate or employer role (several roles per
 *    account since 23.11.2026: that session carries only those roles, never a
 *    staff role); staff-only (xhostd SSO only) and deactivated accounts get
 *    nothing, but a row with a code nobody knows is stored, so the next steps
 *    (wrong code, tries, limits) behave the same for them too.
 *    Limits: per IP (routes.ts) and per address (requestRefusal: 60 s, 5/h, 10/day),
 *    the same for every address → 429 au14 with retryAfter.
 *  POST /api/auth/email/verify {email, code}
 *    The newest code of the address: valid 10 min, single use, 5 tries (each try
 *    is counted in the DB before the comparison, so parallel guesses can't add
 *    tries). Right code:
 *      a candidate account with that email → signed in (via 'email_code');
 *      no account → the sign-up form: a signed httpOnly 20-minute cookie
 *        (email_signup) holds the verified address; nothing is created yet.
 *  GET|POST /api/auth/email/signup  the form's prefill / the account: the same
 *    details and consent checks as every sign-up (checkProfile, checkConsent);
 *    the email only from the cookie. Candidate only.
 *
 *  Never in the log or the console: the address (keyed hash or user:<id>), the code.
 * ========================================================================== */
import { getSignupFields } from '../services/settingsService.js';
import { checkValues as checkCustomValues, userMissingRequired } from '../services/customFieldsService.js';
import { NextFunction, Request, Response } from 'express';
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import { findUserByEmail } from '../dal/userDAL.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import { AuthErrorCodes, AuthErrorMessages, UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { LoginResponse } from '../models/interfaces/general.interface.js';
import { writeAudit, typedEmailRef } from '../security/audit.js';
import { checkConsent } from '../security/consent.js';
import {
  EMAIL_CODE, NEUTRAL_REQUEST_ANSWER, emailCodeEnabled, attemptsLeft, checkCode, cleanCode, emailKey, generateCode, hashCode, isValidEmail,
  normalizeEmail, requestRefusal, sendRefusal,
} from '../security/emailCode.js';
import { readFlow, signFlow } from '../security/oidc.js';
import { checkProfile, hasNonStaffRole, isStaffRole, profileIncomplete, safeErrorText } from '../security/pure.js';
import { effectiveRoles } from '../security/pure.js';
import { isCandidate, primaryRole, rolesOf, usableRolesOf } from '../models/enums.js';
import * as authService from '../services/authService.js';
import { mailSignInCode } from '../mail/triggers.js';
import * as userService from '../services/userService.js';
import { setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { loginActor } from './authController.js';
import { auditLogin, refusedAction, signinContext, signinFailed } from '../security/signins.js';
import { auditEmployerSignup, signUpEmployer, syncEmployerLater, wantsEmployer, withEmployerDetails } from '../services/employerAccounts.js';

const anon = (req: Request) => `anonymous:${req.ip}`;
/** Feature switch off (EMAIL_CODE_SIGNIN_ENABLED): every route answers this and does nothing else. */
const refuseIfOff = (res: Response): boolean => {
  if (emailCodeEnabled()) return false;
  res.status(503).json({ message: AuthErrorMessages.EMAIL_CODE_DISABLED, code: AuthErrorCodes.EMAIL_CODE_DISABLED });
  return true;
};
const isDev = () => appConfig.isDevMode && process.env.NODE_ENV !== 'production';

// ---- the pending sign-up of a verified new address ---------------------------------------
const SIGNUP_COOKIE = 'email_signup';
const SIGNUP_PROVIDER = 'email_signup';
const SIGNUP_PATH = '/api/auth';
export const EMAIL_SIGNUP_SECONDS = 20 * 60;
const cookieOpts = () => ({ httpOnly: true, secure: !appConfig.isDevMode, sameSite: 'strict' as const, path: SIGNUP_PATH });
const setSignupCookie = (res: Response, email: string) =>
  res.cookie(SIGNUP_COOKIE, signFlow(SIGNUP_PROVIDER, { email }, EMAIL_SIGNUP_SECONDS), { ...cookieOpts(), maxAge: EMAIL_SIGNUP_SECONDS * 1000 });
const clearSignupCookie = (res: Response) => res.clearCookie(SIGNUP_COOKIE, cookieOpts());
const readSignup = (req: Request): { email: string } | null => {
  const p = readFlow(SIGNUP_PROVIDER, req.cookies?.[SIGNUP_COOKIE]);
  const email = normalizeEmail(p?.email);
  return email && isValidEmail(email) ? { email } : null;
};

// ---- development only: the last code per address, so the e2e scripts can sign in -----------
const devCodes = new Map<string, string>();
const rememberForDev = (key: string, code: string) => {
  if (!isDev()) return;
  devCodes.set(key, code);
  if (devCodes.size > 5000) devCodes.delete(devCodes.keys().next().value as string);
};

const sessionAnswer = async (res: Response, user: any) => {
  const s = await authService.issueSession(user, 'email_code'); // refuses a deactivated account
  setAccessTokenInCookies(res, s.accessToken);
  setRefreshTokenInCookies(res, s.refreshToken);
  // The roles THIS session carries (an emailed code never carries a staff role).
  const roles = effectiveRoles(usableRolesOf(user), 'email_code'); // blocked roles (24.11.2026) never count
  const { password, ...cleanUser } = await withEmployerDetails({ ...user, roles, role: primaryRole(roles) });
  const candidate = isCandidate({ roles });
  const response: LoginResponse & { profileIncomplete: boolean } = {
    jobApplicationsId: candidate ? s.jobApplications : [], user: cleanUser, profileIncomplete: candidate && (profileIncomplete(user, await getSignupFields()) || await userMissingRequired(user)),
  };
  res.setHeader('Cache-Control', 'private, no-store');
  return response;
};

/** Stores a new code for the address (older unused ones die), and removes rows older than a day. */
const storeCode = async (key: string, code: string, sent: boolean, dev = false) => {
  await query(`DELETE FROM email_codes WHERE created_at < now() - make_interval(hours => $1)`, [EMAIL_CODE.keepHours]);
  await query(`UPDATE email_codes SET used_at = now() WHERE email_key = $1 AND used_at IS NULL`, [key]);
  await query(
    `INSERT INTO email_codes (email_key, code_hash, expires_at, sent, dev) VALUES ($1, $2, now() + make_interval(mins => $3), $4, $5)`,
    [key, hashCode(key, code), EMAIL_CODE.ttlMinutes, sent, dev]);
};

// ---------------------------------------------------------------------------
/** POST /api/auth/email/request */
export const requestCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (refuseIfOff(res)) return;
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: AuthErrorMessages.INVALID_EMAIL, code: AuthErrorCodes.INVALID_EMAIL });
    }
    const key = emailKey(email);
    const recent = await query<{ created_at: Date }>(
      `SELECT created_at FROM email_codes WHERE email_key = $1 AND NOT dev AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 20`, [key]);
    const refused = requestRefusal(recent.map((r) => r.created_at));
    // One lookup for every address (role and state together), so the work before the answer is the same.
    const user = await queryOne<{ id: string; email: string; role: string; roles: string[]; blocked_roles: string[]; deactivated_at: Date | null }>(
      `SELECT id, email, role, roles, blocked_roles, deactivated_at FROM users WHERE lower(email) = lower($1)`, [email]);
    const target = typedEmailRef(email, user ? String(user.id) : null);
    if (refused) {
      if (user) signinFailed(req, anon(req), 'auth.email_code_limited', user, { reason: refused.reason }, target);
      else void writeAudit(anon(req), 'auth.email_code_limited', target, { reason: refused.reason });
      res.setHeader('Retry-After', String(refused.retryAfterSeconds));
      return res.status(429).json({ message: AuthErrorMessages.EMAIL_CODE_WAIT, code: AuthErrorCodes.EMAIL_CODE_WAIT, retryAfter: refused.retryAfterSeconds });
    }
    // Blocked (24.11.2026): no role left that a code may carry (candidate / employer) → no code, like a deactivated account.
    const noSend = sendRefusal(user ? { role: user.role, roles: user.roles, deactivated: !!user.deactivated_at,
      blocked: !effectiveRoles(usableRolesOf(user), 'email_code').length } : null, isStaffRole);
    const code = generateCode();
    // Staff / deactivated: a code that is never sent (and never remembered), so the following steps look the same.
    await storeCode(key, noSend ? generateCode() + generateCode() : code, !noSend);
    // The answer leaves before the email does: same text, about the same time, for every address.
    res.json({ data: { message: NEUTRAL_REQUEST_ANSWER, resendAfter: EMAIL_CODE.resendSeconds, validMinutes: EMAIL_CODE.ttlMinutes } });

    if (noSend) {
      signinFailed(req, anon(req), noSend === 'staff' ? 'auth.email_code_refused_staff' : noSend === 'blocked' ? 'auth.email_code_refused_blocked'
        : 'auth.email_code_refused_deactivated', user, {}, target);
      return;
    }
    rememberForDev(key, code);
    void writeAudit(anon(req), 'auth.email_code_requested', target, { account: user ? 'existing' : 'new' });
    // The template edited on the mail screen (src/mail; the default text when none is published). Never throws.
    void mailSignInCode(email, code).then((r) => {
      if (r.status === 'failed' || r.status === 'suppressed') {
        void writeAudit('system:email', 'auth.email_code_send_failed', target, { error: r.status === 'suppressed' ? 'suppressed' : (r.error ?? 'em1').split(':')[0] });
      }
    });
  } catch (e) {
    if (res.headersSent) { console.error(`[email-code] request failed after answer: ${safeErrorText(e)}`); return; }
    next(e);
  }
};

/** POST /api/auth/email/verify */
export const verifyCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (refuseIfOff(res)) return;
    const email = normalizeEmail(req.body?.email);
    const typed = cleanCode(req.body?.code);
    const invalid = (extra: Record<string, unknown> = {}) =>
      res.status(400).json({ message: AuthErrorMessages.EMAIL_CODE_INVALID, code: AuthErrorCodes.EMAIL_CODE_INVALID, ...extra });
    if (!isValidEmail(email)) return res.status(400).json({ message: AuthErrorMessages.INVALID_EMAIL, code: AuthErrorCodes.INVALID_EMAIL });
    const key = emailKey(email);
    const ref = () => typedEmailRef(email, null);
    if (!typed) return invalid();
    // Count the try first (atomically): only maxAttempts tries ever reach the comparison, in parallel or not.
    const row = await queryOne<{ id: string; code_hash: string; expires_at: Date; attempts: number; used_at: Date | null }>(
      `UPDATE email_codes SET attempts = attempts + 1
        WHERE id = (SELECT id FROM email_codes WHERE email_key = $1 ORDER BY created_at DESC, id DESC LIMIT 1)
          AND used_at IS NULL AND expires_at > now() AND attempts < $2
        RETURNING id, code_hash, expires_at, attempts, used_at`, [key, EMAIL_CODE.maxAttempts]);
    if (!row) {
      // No live code: never requested, expired, used, or out of tries. Which one is said only as "locked" when
      // the newest code ran out of tries (true for staff rows too, so it reveals nothing about the account).
      const newest = await queryOne<{ attempts: number; used_at: Date | null; expires_at: Date }>(
        `SELECT attempts, used_at, expires_at FROM email_codes WHERE email_key = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [key]);
      const locked = !!newest && !newest.used_at && newest.attempts >= EMAIL_CODE.maxAttempts && new Date(newest.expires_at) > new Date();
      void writeAudit(anon(req), 'auth.email_code_failed', ref(), { reason: locked ? 'locked' : newest ? 'expired_or_used' : 'none' });
      if (locked) return res.status(400).json({ message: AuthErrorMessages.EMAIL_CODE_LOCKED, code: AuthErrorCodes.EMAIL_CODE_LOCKED });
      return invalid();
    }
    // The row was counted above; check it as it was before this try.
    const result = checkCode({ ...row, attempts: row.attempts - 1 }, hashCode(key, typed));
    if (result !== 'ok') {
      const left = attemptsLeft(row.attempts);
      void writeAudit(anon(req), 'auth.email_code_failed', ref(), { reason: 'wrong', attempts_left: left });
      if (left === 0) return res.status(400).json({ message: AuthErrorMessages.EMAIL_CODE_LOCKED, code: AuthErrorCodes.EMAIL_CODE_LOCKED });
      return invalid({ attemptsLeft: left });
    }
    // Single use: only one request can mark it.
    const claimed = await queryOne(`UPDATE email_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [row.id]);
    if (!claimed) return invalid();
    devCodes.delete(key);

    const user = await findUserByEmail(email);
    if (user && !hasNonStaffRole(rolesOf(user))) {
      // Cannot happen (no code is sent to a staff-only account); refused the same way if it ever does.
      signinFailed(req, anon(req), 'auth.email_code_refused_staff', user, { step: 'verify' }, typedEmailRef(email, String(user._id)));
      return invalid();
    }
    if (user) {
      let response;
      try {
        response = await sessionAnswer(res, user);
      } catch (e) {
        signinFailed(req, anon(req), refusedAction(e) === 'auth.login_refused_blocked' ? 'auth.email_code_refused_blocked' : 'auth.email_code_refused_deactivated',
          user, { step: 'verify' }, typedEmailRef(email, String(user._id)));
        return invalid();
      }
      auditLogin(req, user, 'email_code');
      return res.json({ data: { status: 'signed_in', ...response } });
    }
    // A new address, now proven: the sign-up form. Nothing is created until it is sent.
    setSignupCookie(res, email);
    void writeAudit(anon(req), 'auth.email_code_verified', ref(), { next: 'signup' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: { status: 'signup', email } });
  } catch (e) {
    next(e);
  }
};

/** GET /api/auth/email/signup — the verified address of the pending sign-up (the visitor's own cookie), or null. */
export const pendingSignup = (req: Request, res: Response) => {
  const p = emailCodeEnabled() ? readSignup(req) : null;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ data: p ? { email: p.email, firstName: '', lastName: '' } : null });
};

/** POST /api/auth/email/signup — creates the candidate (no password) and signs them in. */
export const completeSignup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (refuseIfOff(res)) return;
    const p = readSignup(req);
    if (!p) {
      clearSignupCookie(res);
      return res.status(401).json({ message: AuthErrorMessages.EMAIL_SIGNUP_EXPIRED, code: AuthErrorCodes.EMAIL_SIGNUP_EXPIRED });
    }
    if (wantsEmployer(req.body)) {
      // An employer account (services/employerAccounts.ts): the address from the cookie, role always 'employer'.
      const r = await signUpEmployer(req.body, p.email);
      if (!r.ok) return res.status(r.status).json(r.body);
      clearSignupCookie(res);
      const response = await sessionAnswer(res, r.user);
      auditEmployerSignup(loginActor(r.user), String(r.user.id), 'email_code', req.body?.marketingConsent === true, signinContext(req));
      auditLogin(req, r.user, 'email_code');
      syncEmployerLater(String(r.user.id), loginActor(r.user));
      return res.json({ data: response });
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
    const v = check.values;
    // Email from the signed cookie (the address the code went to), never from the form; role is always 'user'.
    const dto: CreateUserDto = {
      email: p.email, firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber, citySymbol: v.citySymbol,
      gender: v.gender, dateOfBirth: v.dateOfBirth, idNumber: v.idNumber ?? null, skills: v.skills ?? [], cvFileUrl: v.cvFileUrl, hasAppliedToJob: false,
      customFields: extra.values,
    };
    const { user } = await userService.createUser(dto, { consent: { marketing: consent.value.marketing === true } }); // email/phone taken → us2 / us3
    clearSignupCookie(res);
    const response = await sessionAnswer(res, user);
    void writeAudit(loginActor(user), 'auth.email_code_signup', String(user.id), { role: user.role, has_cv: !!user.cvFileUrl, marketing: consent.value.marketing === true, custom_fields: Object.keys(extra.values), ...signinContext(req) });
    auditLogin(req, user, 'email_code');
    return res.json({ data: response });
  } catch (e) {
    next(e);
  }
};

// ---- development only (mounted only with DEV_MODE=true outside production; routes.ts) --------
/** GET /api/dev/email-code?email= — the last code sent to that address (e2e scripts read it instead of an inbox). */
export const devLastCode = (req: Request, res: Response) => {
  if (!isDev()) return res.status(404).end();
  if (refuseIfOff(res)) return;
  const code = devCodes.get(emailKey(normalizeEmail(req.query.email)));
  return code ? res.json({ data: { code } }) : res.status(404).json({ message: 'no code' });
};

/** POST /api/dev/email-code {email} — a fresh code for that address, without the per-address limits (e2e only). */
export const devMintCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDev()) return res.status(404).end();
    if (refuseIfOff(res)) return;
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ message: AuthErrorMessages.INVALID_EMAIL, code: AuthErrorCodes.INVALID_EMAIL });
    const user = await findUserByEmail(email);
    if (user && !hasNonStaffRole(rolesOf(user))) return res.status(403).json({ message: 'staff sign in with SSO', code: AuthErrorCodes.STAFF_SSO_ONLY });
    const key = emailKey(email);
    const code = generateCode();
    await storeCode(key, code, false, true); // dev: not counted in the per-address limits
    rememberForDev(key, code);
    return res.json({ data: { code } });
  } catch (e) {
    next(e);
  }
};
