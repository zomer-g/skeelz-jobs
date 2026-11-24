/* ============================================================================
 *  Adding a role to oneself (owner, 23.11.2026: one person may be a candidate,
 *  an employer and staff at once; docs/security.md "Several roles per account").
 *
 *   POST /api/users/me/roles/candidate  the candidate sign-up form (the sign-up
 *        fields setting, checkProfile; consent): a staff member or an employer
 *        becomes a candidate too, on the same account.
 *   POST /api/users/me/roles/employer   the employer form (checkEmployerProfile;
 *        consent): a candidate or staff member becomes an employer too.
 *
 *  Gate anyAccount (any signed-in account, roles from the DB). The email and the
 *  sign-in stay the account's; the id comes from the session, never the request.
 *  Staff roles are never added here: only an admin gives them (staff screen).
 *  Each addition is logged (auth.role_added, the role only, never field values).
 * ========================================================================== */
import { linkRemovalToNewCandidate } from '../dal/marketingDAL.js';
import { NextFunction, Request, Response } from 'express';
import * as userDAL from '../dal/userDAL.js';
import { UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { queryOne } from '../config/db.js';
import { checkConsent } from '../security/consent.js';
import { checkProfile, isDbError } from '../security/pure.js';
import { claimCvUpload } from '../services/s3Service.js';
import { getSignupFields } from '../services/settingsService.js';
import { checkValues, saveUserValues } from '../services/customFieldsService.js';
import { queueSalesforce } from '../services/salesforceSync.js';
import { mailWelcome } from '../mail/triggers.js';
import { addEmployerRoleTo, syncEmployerLater } from '../services/employerAccounts.js';

/** A role an admin blocked on this account (24.11.2026) is never added back by the person. */
const isBlocked = async (userId: string, role: 'user' | 'employer') =>
  (await queryOne<{ b: boolean }>(`SELECT $2 = ANY(blocked_roles) AS b FROM users WHERE id = $1`, [userId, role]))?.b === true;
const blockedAnswer = (req: Request, res: Response, role: string) => {
  auditDenied(req, `role_blocked:${role}`);
  return res.status(403).json({ message: 'This role is blocked on this account', code: 'role_blocked' });
};

const alreadyHeld = (res: Response) => res.status(409).json({ message: 'This account already holds this role', code: 'role_already_held' });

export const addCandidate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser!.id;
    if (await isBlocked(userId, 'user')) return blockedAnswer(req, res, 'user');
    const check = checkProfile(req.body, { requireAll: true, fields: await getSignupFields() });
    // The added sign-up questions (settings screen), like every sign-up: required ones answered, the rest checked
    // (security review 24.11.2026, M1).
    const extra = await checkValues('signup', req.body?.customFields, { requireAll: true });
    if (!check.ok || !extra.ok) {
      const bad = [...(check.ok ? [] : check.bad), ...(extra.ok ? [] : extra.bad.map((id) => `customFields.${id}`))];
      return res.status(400).json({ message: UserErrorMessages.CREATE_USER_FAILED, code: UserErrorCodes.CREATE_USER_FAILED, fields: bad });
    }
    const consent = checkConsent(req.body, { needTerms: true, askMarketing: true });
    if (!consent.ok) return res.status(400).json({ message: 'Consent is required', code: consent.error });
    const v = check.values;
    let user;
    try {
      user = await userDAL.addCandidateRole(userId, {
        firstName: v.firstName, lastName: v.lastName, phoneNumber: v.phoneNumber, dateOfBirth: v.dateOfBirth,
        gender: v.gender, citySymbol: v.citySymbol, idNumber: v.idNumber ?? null, skills: v.skills ?? [],
      }, { marketing: consent.value.marketing === true });
    } catch (e: any) {
      if (isDbError(e) && e.code === '23505') {
        return res.status(409).json({ message: UserErrorMessages.PHONE_NUMBER_EXISTS, code: UserErrorCodes.PHONE_NUMBER_EXISTS });
      }
      throw e;
    }
    if (!user) return alreadyHeld(res);
    await saveUserValues(userId, extra.values); // after the role is there (saveUserValues writes candidates only)
    await linkRemovalToNewCandidate(userId, user.email, consent.value.marketing === true);
    // A CV uploaded on the form becomes this candidate's (cv.attached, like a sign-up).
    if (v.cvFileUrl) {
      const key = await claimCvUpload(v.cvFileUrl, userId, { via: 'signup' });
      if (key) await userDAL.updateUserById(userId, { cvFileUrl: key });
    }
    void mailWelcome(user); // a new candidate, like a sign-up (kind welcome; nothing when the event is off)
    void writeAudit(actorOf(req), 'auth.role_added', userId, { role: 'user', has_cv: !!v.cvFileUrl, marketing: consent.value.marketing === true,
      custom_fields: Object.keys(extra.values) });
    void queueSalesforce('candidate', userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { ok: true, role: 'user' } });
  } catch (e) { next(e); }
};

export const addEmployer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser!.id;
    if (await isBlocked(userId, 'employer')) return blockedAnswer(req, res, 'employer');
    const r = await addEmployerRoleTo(userId, req.body);
    if (!r.ok) return res.status(r.status).json(r.body);
    void writeAudit(actorOf(req), 'auth.role_added', userId, { role: 'employer', marketing: req.body?.marketingConsent === true });
    syncEmployerLater(userId, actorOf(req));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { ok: true, role: 'employer' } });
  } catch (e) { next(e); }
};
