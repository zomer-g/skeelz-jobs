import { IAuthJwtPayload } from "../models/interfaces/general.interface.js";
import * as tokenUtilityService from './tokenUtilityService.js';
import * as tokenStorageService from './tokenStorageService.js';
import * as jobApplicationService from './jobApplicationService.js';
import appConfig from "../config/appConfig.js";
import { TokenType, usableRolesOf } from "../models/enums.js";
import { AxiosError } from "axios";
import { AuthErrorCodes, AuthErrorMessages } from "../i18n/i18n.js";
import IUser from "../models/schemas/user.js";
import { SignInMethod, effectiveRoles } from "../security/pure.js";
import { query, queryOne } from "../config/db.js";

// Candidates sign in with Google (xhostd SSO) or a code sent by email (controllers/emailSigninController.ts);
// staff with xhostd SSO only. There is no password sign-in, sign-up or reset (removed 11.2026).

/** Tokens for a signed-in user. `via` rides in both tokens and is checked on every request (jwtAuthMiddleware). */
export const issueSession = async (user: IUser, via: SignInMethod) => {
  const userID = user._id.toString();
  // A deactivated account (staff users screen) can't sign in.
  const state = await queryOne<{ deactivated_at: Date | null; roles: string[]; role: string; blocked_roles: string[] }>(
    `SELECT deactivated_at, roles, role, blocked_roles FROM users WHERE id = $1`, [userID]);
  if (state?.deactivated_at) {
    throw new AxiosError(AuthErrorMessages.ACCOUNT_UNAVAILABLE, AuthErrorCodes.ACCOUNT_UNAVAILABLE);
  }
  // Per-role blocks (24.11.2026): the session must carry at least one role that is not blocked and that this sign-in
  // method allows (staff roles: Google only). Otherwise nobody signs in — every sign-in path comes through here.
  if (state && !effectiveRoles(usableRolesOf(state), via).length) {
    throw new AxiosError(AuthErrorMessages.ROLES_BLOCKED, AuthErrorCodes.ROLES_BLOCKED);
  }
  const jobApplications = await jobApplicationService.findJobsApplictionByUserId(userID);
  const accessToken = tokenUtilityService.generateAccessToken({ userID, userRole: user.role, via });
  const refreshToken = await generateAndStoreRefreshToken({ userID, userRole: user.role, via });
  return { accessToken, refreshToken, jobApplications };
};

export const jobApplicationsOf = (userID: string) => jobApplicationService.findJobsApplictionByUserId(userID);

export const generateAndStoreRefreshToken = async (payload: IAuthJwtPayload): Promise<string> => {
  const token = tokenUtilityService.generateRefreshToken(payload);
  await tokenStorageService.createToken(payload.userID, token, appConfig.refreshTokenLifeSeconds, TokenType.REFRESH_TOKEN);
  return token;
};

export const logout = async (userID: string) => {
  // Every refresh token of the account was already disabled here; access tokens issued until now stop too, so
  // a copied cookie is not good for its remaining minutes.
  await tokenStorageService.invalidateTokens(userID, TokenType.REFRESH_TOKEN);
  await query(`UPDATE users SET sessions_revoked_at = now() WHERE id = $1`, [userID]);
}

export const refreshAccessToken = async (refreshToken: string): Promise<{ refreshTokenPayload: IAuthJwtPayload, newAccessToken: string }> => {
  const decodedRefreshToken = await validateRefreshToken(refreshToken);
  const userID = decodedRefreshToken?.userID;
  if (!userID) {
    throw new AxiosError(AuthErrorMessages.INVALID_REFRESH_TOKEN, AuthErrorCodes.INVALID_REFRESH_TOKEN);
  }
  const accessTokenPaylod: IAuthJwtPayload = {
    userID: decodedRefreshToken.userID,
    userRole: decodedRefreshToken.userRole,
    via: decodedRefreshToken.via,
  };
  const newAccessToken = tokenUtilityService.generateAccessToken(accessTokenPaylod);

  return { refreshTokenPayload: decodedRefreshToken, newAccessToken };
};

export const validateRefreshToken = async (token: string): Promise<IAuthJwtPayload | null> => {
  const decoded = tokenUtilityService.verifyRefreshToken(token);
  const storedToken = await tokenStorageService.findActiveToken(decoded.userID, TokenType.REFRESH_TOKEN);

  if (!storedToken) {
    throw new AxiosError(AuthErrorMessages.REFRESH_TOKEN_NOT_FOUND, AuthErrorCodes.REFRESH_TOKEN_NOT_FOUND);
  }

  const isTokenValid = tokenUtilityService.compareTokenWithHash(token, storedToken.token);
  if (!isTokenValid || storedToken.expiresAt < new Date()) {
    throw new AxiosError(AuthErrorMessages.INVALID_REFRESH_TOKEN, AuthErrorCodes.INVALID_REFRESH_TOKEN);
  }

  //TODO: maybe to check if user exists

  await tokenStorageService.markTokenAsUsed(storedToken._id);
  return decoded;
};
