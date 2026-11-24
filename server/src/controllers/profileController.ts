/* ============================================================================
 *  The personal area: a signed-in CANDIDATE reads and edits their own details.
 *
 *  There is no user id in these routes: the record is always the caller's own
 *  (id from the session, never from the body or the path), and only candidates'
 *  records (role 'user') are touched — staff accounts are the admins' (staff
 *  users screen). Fields: the allowlist in security/pure.ts (PROFILE_FIELDS),
 *  checked with the same rules as the sign-up form. Email is read-only (it is
 *  the sign-in name, and the SSO identity for Google accounts); role and
 *  password can't be set here. Each change is logged with field NAMES only.
 * ========================================================================== */
import { getSignupFields } from '../services/settingsService.js';
import { checkValues as checkCustomValues, saveUserValues, userMissingRequired, userValues } from '../services/customFieldsService.js';
import { NextFunction, Request, Response } from 'express';
import { AxiosError } from 'axios';
import * as userDAL from '../dal/userDAL.js';
import { setOwnMarketing } from '../dal/marketingDAL.js';
import { removeFromList } from '../services/marketingList.js';
import * as userService from '../services/userService.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { checkProfile, profileIncomplete } from '../security/pure.js';
import { AuthErrorCodes, AuthErrorMessages, UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { isCandidate } from '../models/enums.js';
import { convertToIsraelTimeAndStoreAsUTC } from '../utils/utils.js';
import { checkConsent, TERMS_VERSION } from '../security/consent.js';
import IUser from '../models/schemas/user.js';
import { queueSalesforce } from '../services/salesforceSync.js';
import { assertCandidateEditable } from '../middleware/errorMiddleware.js';

/** The caller's own candidate record, or a refusal (no candidate role: 403; nobody: 401). */
const ownCandidate = async (req: Request): Promise<IUser> => {
  const id = req.authUser?.id;
  if (!id) throw Object.assign(new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED), { status: 401 });
  const user = await userDAL.findUserById(id);
  if (!user) throw Object.assign(new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED), { status: 401 });
  // Someone holding the candidate role (also when they are staff or an employer too); others: 403.
  if (!isCandidate(user)) throw Object.assign(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN), { status: 403 });
  return user;
};

const refuse = (res: Response, e: any) => res.status(e.status).json({ message: e.message, code: e.code });

const view = async (user: IUser) => {
  const { password, ...clean } = user as any;
  const c = await userDAL.getConsent(String(user.id));
  return {
    // The candidate's own ID number (only here and on the staff candidates list; never in logs or analytics).
    // Their answers to the added sign-up fields (settings screen), keyed by field id.
    user: { ...clean, idNumber: await userDAL.findIdNumber(String(user.id)), customFields: await userValues(String(user.id)) },
    ...(await userDAL.signInFacts(String(user.id))),
    // A candidate of the existing site before the cutover: details shown, not editable (they apply to this site's jobs).
    readOnly: user.legacyState === 'mirror',
    profileIncomplete: user.legacyState === 'mirror' ? false : (profileIncomplete(user, await getSignupFields()) || await userMissingRequired(user)),
    // The two boxes (security/consent.ts): the marketing answer can be changed here at any time.
    consent: { termsCurrent: c?.termsVersion === TERMS_VERSION, marketing: c?.marketingConsent ?? null, marketingAt: c?.marketingConsentAt ?? null },
  };
};

// GET /users/me
export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await ownCandidate(req);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: await view(user) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};

// PATCH /users/me — only the allowlisted fields; an empty value never clears a required one.
export const updateMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await ownCandidate(req);
    assertCandidateEditable(user); // a candidate of the existing site views only, until the cutover
    const check = checkProfile(req.body, { fields: await getSignupFields(), allowClear: true });
    // Added sign-up fields: only the ones sent are checked; an empty answer clears an optional one, never a required one.
    const extra = req.body?.customFields === undefined ? { ok: true as const, values: {} } : await checkCustomValues('signup', req.body.customFields);
    if (!check.ok || !extra.ok) {
      const bad = [...(check.ok ? [] : check.bad), ...(extra.ok ? [] : extra.bad.map((id) => `customFields.${id}`))];
      return res.status(400).json({ message: UserErrorMessages.UPDATE_USER_FAILED, code: UserErrorCodes.UPDATE_USER_FAILED, fields: bad });
    }
    const values: Record<string, any> = { ...check.values };
    const extraIds = Object.keys(extra.values);
    const fields = [...Object.keys(values), ...extraIds.map((id) => `customFields.${id}`)];
    if (!fields.length) return res.json({ data: await view(user) });
    // Same rule as the form: a field that the setting requires can't be cleared (checkProfile drops empty values).
    if (values.phoneNumber && values.phoneNumber !== user.phoneNumber && await userService.phoneTakenByOther(values.phoneNumber, String(user.id))) {
      return res.status(400).json({ message: UserErrorMessages.PHONE_NUMBER_EXISTS, code: UserErrorCodes.PHONE_NUMBER_EXISTS });
    }
    if (values.dateOfBirth) values.dateOfBirth = convertToIsraelTimeAndStoreAsUTC(values.dateOfBirth); // as at sign-up
    // Same path as the content managers' edit (CV upload claimed for this user only; candidates only).
    const updated = await userService.updateUserById(String(user.id), values, { candidatesOnly: true });
    if (!updated) throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
    await saveUserValues(String(user.id), extra.values);
    // Field names only (an added field by its id), never the values.
    void writeAudit(actorOf(req), 'user.profile_updated', 'self', { fields });
    return res.json({ data: await view(updated) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};

// DELETE /users/me/cv — the profile no longer has a CV. The file itself is kept: past applications may point to it.
export const removeMyCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await ownCandidate(req);
    assertCandidateEditable(user);
    if (!user.cvFileUrl) return res.json({ data: await view(user) });
    const updated = await userDAL.updateUserById(String(user.id), { cvFileUrl: '' }, { candidatesOnly: true });
    if (!updated) throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
    void queueSalesforce('candidate', String(user.id)); // the Contact's CV link (files in Salesforce are never deleted)
    void writeAudit(actorOf(req), 'user.profile_updated', 'self', { fields: ['cvFileUrl'], removed: true });
    return res.json({ data: await view(updated) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};

// PUT /users/me/marketing-consent — { marketingConsent: boolean }: give or withdraw consent to marketing mail and
// updates about cooperations. Only a "yes" lets the address reach the mailing list (security/consent.ts).
export const setMarketingConsent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await ownCandidate(req);
    const m = req.body?.marketingConsent;
    if (typeof m !== 'boolean') return res.status(400).json({ message: 'marketingConsent must be true or false', code: 'marketing_invalid' });
    const before = (await userDAL.getConsent(String(user.id)))?.marketingConsent ?? null;
    // "No" puts the address on the removal list; "yes" (their own) clears it (security/marketing.ts).
    await setOwnMarketing(String(user.id), m, actorOf(req));
    if (!m) void removeFromList(user.email); // SMOOV too, when on (services/marketingList.ts)
    void writeAudit(actorOf(req), 'user.marketing_consent_changed', 'self', { marketing: m, before });
    return res.json({ data: await view(user) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};

// PUT /users/me/terms — { consent: true, marketingConsent?: boolean }: the consent step at sign-in (owner, 23.11.2026).
// A candidate whose terms are not accepted in their current version (one copied from the existing site never accepted
// them here) is asked right after signing in, with the same two boxes as everywhere (security/consent.ts). The
// marketing answer is taken only if they never answered it (their later choice stays in the personal area). Stored
// with a consent_records row in the same statement (recordConsent, source 'first_signin'). Declining stores nothing:
// they stay signed in, and applying asks again (428 consent_needed → the apply dialog).
export const acceptTerms = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await ownCandidate(req);
    const state = await userDAL.getConsent(String(user.id));
    const answered = state?.marketingConsent !== null && state?.marketingConsent !== undefined;
    const check = checkConsent(req.body, { needTerms: true, askMarketing: !answered });
    if (!check.ok) return res.status(400).json({ message: 'Consent is required', code: check.error });
    const record: { terms?: true; marketing?: boolean } = {};
    if (state?.termsVersion !== TERMS_VERSION) record.terms = true;
    if (!answered && typeof check.value.marketing === 'boolean') record.marketing = check.value.marketing;
    if (record.terms || record.marketing !== undefined) {
      await userDAL.recordConsent(String(user.id), record, 'first_signin');
      void writeAudit(actorOf(req), 'user.terms_accepted', 'self', { terms_accepted: !!record.terms, marketing: record.marketing ?? null });
    }
    return res.json({ data: await view((await userDAL.findUserById(String(user.id))) ?? user) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};
