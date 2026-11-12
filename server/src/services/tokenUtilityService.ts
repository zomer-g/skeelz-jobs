import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import appConfig from '../config/appConfig.js';
import { IAuthJwtPayload, IPasswordResetJwtPayload } from '../models/interfaces/general.interface.js';

// Helper function to generate a salt and hash a token
export const hashTokenWithSalt = (token: string): string => {
  const salt = crypto.randomBytes(16).toString('hex'); // Generate salt
  const hash = crypto.pbkdf2Sync(token, salt, 100000, 64, 'sha256').toString('hex'); // Hash token with salt
  return `${salt}:${hash}`; // Concatenate salt and hash
};

// Helper function to verify a token against a stored hash and salt
export const compareTokenWithHash = (token: string, storedTokenWithSalt: string): boolean => {
  const [salt, storedHash] = storedTokenWithSalt.split(':');
  const hash = crypto.pbkdf2Sync(token, salt, 100000, 64, 'sha256').toString('hex');
  return hash === storedHash;
};

// JWT Utility Functions

export const generateAccessToken = (payload: IAuthJwtPayload) => {
  return jwt.sign(payload, appConfig.accessTokenSecret, { expiresIn: appConfig.accessTokenLifeSeconds });
};

export const generateRefreshToken = (payload: IAuthJwtPayload) => {
  return jwt.sign(payload, appConfig.refreshTokenSecret, { expiresIn: appConfig.refreshTokenLifeSeconds });
};

export const generatePasswordResetToken = (payload: IPasswordResetJwtPayload) => {
  return jwt.sign(payload, appConfig.passwordResetTokenSecret, { expiresIn: appConfig.passwordResetTokenLifeSeconds });
};

// JWT Verification Functions

export const verifyAccessToken = (token: string): IAuthJwtPayload => {
  return jwt.verify(token, appConfig.accessTokenSecret) as IAuthJwtPayload;
};

export const verifyRefreshToken = (token: string): IAuthJwtPayload => {
  return jwt.verify(token, appConfig.refreshTokenSecret) as IAuthJwtPayload;
};

export const verifyPasswordResetToken = (token: string): IPasswordResetJwtPayload => {
  return jwt.verify(token, appConfig.passwordResetTokenSecret) as IPasswordResetJwtPayload;
};

