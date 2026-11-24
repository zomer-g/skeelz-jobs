/* ============================================================================
 *  Employer accounts: sign-up (shared by the three ways in) and the employer's
 *  Salesforce Contact. Rules: docs/employers.md.
 *
 *  Sign-up happens on the same form as a candidate's, after the identity was
 *  verified (Google via xhostd, Microsoft, or a code by email): the visitor
 *  chooses "employer" and the form posts accountType: 'employer'. The email is
 *  always the verified one from the signed sign-up cookie. A NEW address gets
 *  a new employer account here. Since 23.11.2026 (owner: one person may be a
 *  candidate, an employer and staff at once) an EXISTING account signs in as
 *  itself and adds the employer role from inside its session (addEmployerRole,
 *  POST /api/users/me/roles/employer): same form, same checks, same audit.
 *
 *  Salesforce (only with ENABLE_SALESFORCE=true; off in production today): one
 *  Contact per employer, standard fields only. Sync state in salesforce_sync
 *  (kind 'employer'), error CODES only. With Salesforce off nothing leaves.
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import * as employerDAL from '../dal/employerDAL.js';
import { salesforceErrorCode } from '../internalApi/pure.js';
import { writeAudit, writeAuditStrict } from '../security/audit.js';
import { checkConsent } from '../security/consent.js';
import { checkEmployerProfile, EmployerProfile } from '../security/employer.js';
import { safeErrorText } from '../security/pure.js';
import { queueSalesforce } from './salesforceSync.js';
import { isEmployer } from '../models/enums.js';

/** The sign-up form chose "employer". */
export const wantsEmployer = (body: unknown): boolean =>
  !!body && typeof body === 'object' && (body as Record<string, unknown>).accountType === 'employer';

export type EmployerSignupResult =
  | { ok: true; user: any }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Validates the employer sign-up form and creates the account. `email` = the verified address from the cookie. */
export const signUpEmployer = async (
  body: unknown, email: string, sso?: { sub: string; provider: 'xhostd' | 'microsoft' },
): Promise<EmployerSignupResult> => {
  const check = checkEmployerProfile(body, { requireAll: true });
  if (!check.ok) return { ok: false, status: 400, body: { message: 'Some fields are missing or invalid', code: 'employer_invalid', fields: check.bad } };
  const consent = checkConsent(body, { needTerms: true, askMarketing: true });
  if (!consent.ok) return { ok: false, status: 400, body: { message: 'Consent is required', code: consent.error } };
  try {
    const user = await employerDAL.createEmployer(email, check.values as EmployerProfile, { sso, consent: { marketing: consent.value.marketing === true } });
    return { ok: true, user: { ...user, employer: { companyName: check.values.companyName, phone: check.values.phone, jobTitle: check.values.jobTitle ?? null } } };
  } catch (e: any) {
    if (e?.code === 'email_taken' || e?.code === '23505') {
      return { ok: false, status: 409, body: { message: 'An account with this email already exists', code: 'us2' } };
    }
    throw e;
  }
};

/** A user object for the client: one holding the employer role carries their company details too (session answers). */
export const withEmployerDetails = async <T extends { role?: string; roles?: readonly string[]; _id?: any; id?: any }>(user: T): Promise<T> =>
  isEmployer(user) ? { ...user, employer: await employerSessionExtra(String(user._id ?? user.id)) } : user;

/** Adds the employer role to the signed-in account (any roles it has stay). Same form checks as an employer sign-up. */
export const addEmployerRoleTo = async (userId: string, body: unknown): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> => {
  const check = checkEmployerProfile(body, { requireAll: true });
  if (!check.ok) return { ok: false, status: 400, body: { message: 'Some fields are missing or invalid', code: 'employer_invalid', fields: check.bad } };
  const consent = checkConsent(body, { needTerms: true, askMarketing: true });
  if (!consent.ok) return { ok: false, status: 400, body: { message: 'Consent is required', code: consent.error } };
  const added = await employerDAL.addEmployerRole(userId, check.values as EmployerProfile, { marketing: consent.value.marketing === true });
  return added ? { ok: true } : { ok: false, status: 409, body: { message: 'This account is already an employer', code: 'role_already_held' } };
};

/** What the client gets about a signed-in employer (session answers). */
export const employerSessionExtra = async (userId: string) => {
  const e = await employerDAL.getEmployer(userId);
  return e ? { companyName: e.companyName, phone: e.phone, jobTitle: e.jobTitle } : null;
};

// ---- Salesforce ------------------------------------------------------------------------------
/**
 * After a sign-up or a profile change: the employer's Contact is queued (services/salesforceSync.ts: strict
 * salesforce.pushed entry before sending, retries, state in salesforce_sync kind 'employer'). Off → nothing.
 * Never blocks or fails the request.
 */
export const syncEmployerLater = (userId: string, _actor: string) => {
  void queueSalesforce('employer', userId);
};

/** The common end of an employer sign-up in the controllers: audit lines (no personal data). */
export const auditEmployerSignup = (actor: string, userId: string, method: string, marketing: boolean, ctx: { ip: string; device: string } | null = null) => {
  void writeAudit(actor, 'auth.signup_employer', String(userId), { role: 'employer', method, marketing, ...(ctx ? { ip: ctx.ip || null, device: ctx.device } : {}) });
};

