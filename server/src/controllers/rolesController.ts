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
import { actorOf, writeAudit } from '../security/audit.js';
import { checkConsent } from '../security/consent.js';
import { checkProfile, isDbError } from '../security/pure.js';
import { claimCvUpload } from '../services/s3Service.js';
import { getSignupFields } from '../services/settingsService.js';
import { queueSalesforce } from '../services/salesforceSync.js';
import { mailWelcome } from '../mail/triggers.js';
import { addEmployerRoleTo, syncEmployerLater } from '../services/employerAccounts.js';

const alreadyHeld = (res: Response) => res.status(409).json({ message: 'This account already holds this role', code: 'role_already_held' });

export const addCandidate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser!.id;
    const check = checkProfile(req.body, { requireAll: true, fields: await getSignupFields() });
    if (!check.ok) {
      return res.status(400).json({ message: UserErrorMessages.CREATE_USER_FAILED, code: UserErrorCodes.CREATE_USER_FAILED, fields: check.bad });
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
    await linkRemovalToNewCandidate(userId, user.email, consent.value.marketing === true);
    // A CV uploaded on the form becomes this candidate's (cv.attached, like a sign-up).
    if (v.cvFileUrl) {
      const key = await claimCvUpload(v.cvFileUrl, userId, { via: 'signup' });
      if (key) await userDAL.updateUserById(userId, { cvFileUrl: key });
    }
    void mailWelcome(user); // a new candidate, like a sign-up (kind welcome; nothing when the event is off)
    void writeAudit(actorOf(req), 'auth.role_added', userId, { role: 'user', has_cv: !!v.cvFileUrl, marketing: consent.value.marketing === true });
    void queueSalesforce('candidate', userId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { ok: true, role: 'user' } });
  } catch (e) { next(e); }
};

export const addEmployer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.authUser!.id;
    const r = await addEmployerRoleTo(userId, req.body);
    if (!r.ok) return res.status(r.status).json(r.body);
    void writeAudit(actorOf(req), 'auth.role_added', userId, { role: 'employer', marketing: req.body?.marketingConsent === true });
    syncEmployerLater(userId, actorOf(req));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { ok: true, role: 'employer' } });
  } catch (e) { next(e); }
};
