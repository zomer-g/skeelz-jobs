import { findUserByEmailWithPassword } from "../dal/userDAL.js";
import { LoginUserDto } from "../dto/loginUserDto.js";
import { comparePassword, hashPassword } from "./hashService.js";
import { IAuthJwtPayload, IPasswordResetJwtPayload } from "../models/interfaces/general.interface.js";
import * as tokenUtilityService from './tokenUtilityService.js';
import * as tokenStorageService from './tokenStorageService.js';
import * as jobApplicationService from './jobApplicationService.js';
import appConfig from "../config/appConfig.js";
import { TokenType } from "../models/enums.js";
import { AxiosError } from "axios";
import { AuthErrorCodes, AuthErrorMessages, ResetPasswordErrorCodes, ResetPasswordErrorMessages } from "../i18n/i18n.js";
import * as userService from './userService.js';
import * as emailService from './emailService.js';
import { generatePasswordResetEmail, generateWelcomeEmail } from "../utils/emailTemplates.js";
import jwt from "jsonwebtoken";
import IUser from "../models/schemas/user.js";
import { isStaffRole, SignInMethod } from "../security/pure.js";
import { queryOne } from "../config/db.js";

const { TokenExpiredError } = jwt;

export const loginUser = async (loginUserDto: LoginUserDto) => {
  const { email, password } = loginUserDto;
  
  const user = await findUserByEmailWithPassword(email);
  if (!user) {
    // Same answer as a wrong password, so the form does not reveal which emails are registered.
    throw new AxiosError(AuthErrorMessages.WRONG_PASSWORD, AuthErrorCodes.WRONG_PASSWORD);
  }

  if (!user.password) {
    throw new AxiosError(AuthErrorMessages.MISSING_PASSWORD, AuthErrorCodes.MISSING_PASSWORD);
  }

  const isPasswordValid = await comparePassword(password, user.password);
  if (!isPasswordValid) {
    throw new AxiosError(AuthErrorMessages.WRONG_PASSWORD, AuthErrorCodes.WRONG_PASSWORD);
  }

  // Staff sign in only with xhostd SSO. Checked after the password, so the form never tells someone
  // who does not know the password which emails belong to staff.
  if (isStaffRole(user.role)) {
    throw new AxiosError(AuthErrorMessages.STAFF_SSO_ONLY, AuthErrorCodes.STAFF_SSO_ONLY);
  }

  return { ...(await issueSession(user, 'password')), user };
};

/** Tokens for a signed-in user. `via` rides in both tokens and is checked on every request (jwtAuthMiddleware). */
export const issueSession = async (user: IUser, via: SignInMethod) => {
  const userID = user._id.toString();
  // A deactivated account (staff users screen) can't sign in; same answer as a wrong password.
  const state = await queryOne<{ deactivated_at: Date | null }>(`SELECT deactivated_at FROM users WHERE id = $1`, [userID]);
  if (state?.deactivated_at) {
    throw new AxiosError(AuthErrorMessages.WRONG_PASSWORD, AuthErrorCodes.WRONG_PASSWORD);
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
  await tokenStorageService.invalidateTokens(userID, TokenType.REFRESH_TOKEN);
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

export const generateAndSendResetToken = async (email: string): Promise<void | string > => {
const user = await userService.getUserByEmail(email);
  if (!user) {
  // We do not return an error if the user is not found for security reasons.
  // This prevents revealing whether an email address is registered in the system.

  return "USER_NOT_FOUND";
}
  // Staff have no password sign-in (xhostd SSO only), so no reset link either. The caller answers the same.
  if (isStaffRole(user.role)) return "STAFF";
  const isPasswordUninitialized = !user.password;
  const resetPasswordTokenPayload: IPasswordResetJwtPayload = { userID: (user._id).toString(), isPasswordUninitialized }
  const token = tokenUtilityService.generatePasswordResetToken(resetPasswordTokenPayload);
  await tokenStorageService.createToken(user._id, token, appConfig.passwordResetTokenLifeSeconds, TokenType.RESET_PASSWORD);
  const { subject, text } = generatePasswordResetEmail(token);
  await emailService.sendEmail(user.email, subject, text, true);
  return "SUCCESS";
};

export const resetPassword = async (token: string, newPassword: string): Promise<string> => {
  const { userID, isPasswordUninitialized } = await validateResetTokenAndMarkItAsUsed(token);
  // A link sent before someone became staff must not give a staff account a password.
  const target = await userService.getUserById(userID);
  if (target && isStaffRole(target.role)) {
    throw new AxiosError(AuthErrorMessages.STAFF_SSO_ONLY, AuthErrorCodes.STAFF_SSO_ONLY);
  }
  const hashedPassword = await hashPassword(newPassword);
  await userService.updateUserPassword(userID, hashedPassword);
  // A new password closes every existing session (someone who had the old one is out).
  await tokenStorageService.invalidateTokens(userID, TokenType.REFRESH_TOKEN);
  if (isPasswordUninitialized) {
    const user: IUser | null = await userService.getUserById(userID);
    if (user) {
      const { subject, text } = generateWelcomeEmail(user);
      await emailService.sendEmail(user.email, subject, text);
    }
  }
  return userID;
};

const validateResetTokenAndMarkItAsUsed = async (token: string): Promise<IPasswordResetJwtPayload> => {
  try {
    const decoded = tokenUtilityService.verifyPasswordResetToken(token);
    const storedToken = await tokenStorageService.findActiveUnusedToken(decoded.userID, TokenType.RESET_PASSWORD);
    if (!storedToken) {
      throw new AxiosError(ResetPasswordErrorMessages.TOKEN_NOT_FOUND, ResetPasswordErrorCodes.TOKEN_NOT_FOUND);
    }

    const isTokenValid = await tokenUtilityService.compareTokenWithHash(token, storedToken.token);
    if (!isTokenValid || storedToken.expiresAt < new Date()) {
      throw new AxiosError(ResetPasswordErrorMessages.INVALID_TOKEN, ResetPasswordErrorCodes.INVALID_TOKEN);
    }

    const user = await userService.getUserById(decoded.userID);
    if (!user) {
      throw new AxiosError(ResetPasswordErrorMessages.USER_NOT_FOUND, ResetPasswordErrorCodes.USER_NOT_FOUND);
    }
    await tokenStorageService.markTokenAsUsed(storedToken._id);
    return decoded;
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      throw new AxiosError(ResetPasswordErrorMessages.TOKEN_EXPIRED, ResetPasswordErrorCodes.TOKEN_EXPIRED);
    }
    throw new AxiosError(ResetPasswordErrorMessages.VERIFY_FAILED, ResetPasswordErrorCodes.VERIFY_FAILED);
  }
};
