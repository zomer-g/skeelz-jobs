import { NextFunction, Request, Response } from 'express';
import * as authService from '../services/authService.js';
import { clearAccessAndRefreshTokensFromCookies } from '../utils/authUtils.js';
import { actorName, actorOf, typedEmailRef, writeAudit } from '../security/audit.js';
import { findUserByEmail } from '../dal/userDAL.js';

/** How a signed-in user is named in the log: staff by email, candidates by id (security/audit.ts actorName). */
export const loginActor = (u: { _id?: any; id?: any; email?: string; role?: string }) =>
  actorName({ id: String(u._id ?? u.id), email: String(u.email ?? ''), role: String(u.role ?? '') });

/** The typed email as the log keeps it: user:<id> when the account exists, else a keyed hash (never the address). */
export const typedTarget = async (email: string): Promise<string | null> => {
  if (!email) return null;
  try {
    const u = await findUserByEmail(email);
    return typedEmailRef(email, u ? String(u._id) : null);
  } catch {
    return typedEmailRef(email, null);
  }
};

export const logout = async (req: Request, res: Response) => {
  const userID = req.authJwtPayload?.userID;
  if (userID) {
    await authService.logout(userID);
    void writeAudit(actorOf(req), 'auth.logout');
  }
  clearAccessAndRefreshTokensFromCookies(res);
  res.send({ data: { message: 'Logged out' } })
}
