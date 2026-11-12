import { NextFunction, Request, Response } from 'express';
import { isAxiosError } from 'axios';
import { LoginUserDto } from '../dto/loginUserDto.js';
import { LoginResponse } from '../models/interfaces/general.interface.js';
import IUser from '../models/schemas/user.js';
import * as authService from '../services/authService.js';
import { clearAccessAndRefreshTokensFromCookies, setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { actorName, actorOf, writeAudit } from '../security/audit.js';
import { AuthErrorCodes } from '../i18n/i18n.js';

/** How a signed-in user is named in the log: staff by email, candidates by id (security/audit.ts actorName). */
export const loginActor = (u: { _id?: any; id?: any; email?: string; role?: string }) =>
  actorName({ id: String(u._id ?? u.id), email: String(u.email ?? ''), role: String(u.role ?? '') });

const isStaffRefusal = (e: unknown) => isAxiosError(e) && e.code === AuthErrorCodes.STAFF_SSO_ONLY;

export const login = async (req: Request, res: Response,next: NextFunction)=> {
  const loginUserDto = Object.assign(new LoginUserDto(), req.body);
  const triedEmail = String(loginUserDto?.email ?? '').trim().toLowerCase().slice(0, 200);
  try {
    const result = await authService.loginUser(loginUserDto);
    if (!result) {
      void writeAudit(`anonymous:${req.ip}`, 'auth.login_failed', triedEmail);
      return res.status(401).json({ message: 'Authentication failed' });
    }
    const { password, ...cleanUser } = result.user
    // Tokens go only into httpOnly cookies (they were also in the body, readable by any script on the page).
    const response: LoginResponse = { jobApplicationsId: result.jobApplications, user: cleanUser as Omit<IUser, 'password'> }
    setAccessTokenInCookies(res, result.accessToken);
    setRefreshTokenInCookies(res, result.refreshToken);
    const u = result.user as any;
    void writeAudit(loginActor(u), 'auth.login', null, { role: u.role, method: 'password' });
    return res.status(200).json({ data: response });
  } catch (error) {
      if (isStaffRefusal(error)) {
        // The password was right, but staff sign in only with xhostd SSO. No session was made.
        void writeAudit(triedEmail || `anonymous:${req.ip}`, 'auth.login_refused_staff_password', triedEmail);
        return res.status(403).json({ message: (error as Error).message, code: AuthErrorCodes.STAFF_SSO_ONLY });
      }
      void writeAudit(`anonymous:${req.ip}`, 'auth.login_failed', triedEmail);
      next(error)
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

const GENERIC_RESET_ANSWER = "If this email is registered, a reset link has been sent.";

export const requestPasswordReset = async (req: Request, res: Response, next: NextFunction) => {
  const { email } = req.body;
  const tried = String(email ?? '').trim().toLowerCase().slice(0, 200);
  try {
    const result = await authService.generateAndSendResetToken(email);
    if (result === 'STAFF') {
      // Staff have no password sign-in: no link is sent, and the answer is the generic one.
      void writeAudit(`anonymous:${req.ip}`, 'auth.password_reset_refused_staff', tried);
      return res.json({ data: { message: GENERIC_RESET_ANSWER } });
    }
    void writeAudit(`anonymous:${req.ip}`, 'auth.password_reset_requested', tried, { known: result !== 'USER_NOT_FOUND' });
    if (result === "USER_NOT_FOUND") {
      // Return a generic success message to prevent exposing system info.
      return res.json({ data: { message: GENERIC_RESET_ANSWER } });
    }
    res.json({ data: { message: 'Password reset link sent to email' } });
  } catch (error) {
      next(error)
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  const { token, newPassword } = req.body;
  try {
    const userID = await authService.resetPassword(token, newPassword);
    void writeAudit(`user:${userID}`, 'auth.password_reset', null, { sessions_closed: true });
    res.json({ data: { message: 'Password reset successfully' } });
  } catch (error) {
    if (isStaffRefusal(error)) {
      void writeAudit(`anonymous:${req.ip}`, 'auth.password_reset_refused_staff', null, { via: 'reset_link' });
      return res.status(403).json({ message: (error as Error).message, code: AuthErrorCodes.STAFF_SSO_ONLY });
    }
    next(error);
  }
};
