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
import { NextFunction, Request, Response } from 'express';
import { AxiosError } from 'axios';
import * as userDAL from '../dal/userDAL.js';
import * as userService from '../services/userService.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { checkProfile, profileIncomplete } from '../security/pure.js';
import { AuthErrorCodes, AuthErrorMessages, UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { UserRole } from '../models/enums.js';
import { convertToIsraelTimeAndStoreAsUTC } from '../utils/utils.js';
import IUser from '../models/schemas/user.js';

/** The caller's own candidate record, or a refusal (staff: 403; nobody: 401). */
const ownCandidate = async (req: Request): Promise<IUser> => {
  const id = req.authUser?.id;
  if (!id) throw Object.assign(new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED), { status: 401 });
  const user = await userDAL.findUserById(id);
  if (!user) throw Object.assign(new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED), { status: 401 });
  if (user.role !== UserRole.USER) throw Object.assign(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN), { status: 403 });
  return user;
};

const refuse = (res: Response, e: any) => res.status(e.status).json({ message: e.message, code: e.code });

const view = async (user: IUser) => {
  const { password, ...clean } = user as any;
  return { user: clean, ...(await userDAL.signInFacts(String(user.id))), profileIncomplete: profileIncomplete(user) };
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
    const check = checkProfile(req.body);
    if (!check.ok) {
      return res.status(400).json({ message: UserErrorMessages.UPDATE_USER_FAILED, code: UserErrorCodes.UPDATE_USER_FAILED, fields: check.bad });
    }
    const values: Record<string, any> = { ...check.values };
    const fields = Object.keys(values);
    if (!fields.length) return res.json({ data: await view(user) });
    if (values.phoneNumber && values.phoneNumber !== user.phoneNumber && await userService.phoneTakenByOther(values.phoneNumber, String(user.id))) {
      return res.status(400).json({ message: UserErrorMessages.PHONE_NUMBER_EXISTS, code: UserErrorCodes.PHONE_NUMBER_EXISTS });
    }
    if (values.dateOfBirth) values.dateOfBirth = convertToIsraelTimeAndStoreAsUTC(values.dateOfBirth); // as at sign-up
    // Same path as the content managers' edit (CV upload claimed for this user only; candidates only).
    const updated = await userService.updateUserById(String(user.id), values, { candidatesOnly: true });
    if (!updated) throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
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
    if (!user.cvFileUrl) return res.json({ data: await view(user) });
    const updated = await userDAL.updateUserById(String(user.id), { cvFileUrl: '' }, { candidatesOnly: true });
    if (!updated) throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
    void writeAudit(actorOf(req), 'user.profile_updated', 'self', { fields: ['cvFileUrl'], removed: true });
    return res.json({ data: await view(updated) });
  } catch (e: any) {
    if (e?.status) return refuse(res, e);
    next(e);
  }
};
