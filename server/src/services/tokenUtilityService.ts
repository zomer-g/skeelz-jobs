import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import appConfig from '../config/appConfig.js';
import { IAuthJwtPayload } from '../models/interfaces/general.interface.js';

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
// Each kind of token carries `typ` and is checked for it on verify (on top of having its own secret), so a token
// of one kind is never accepted as another even if two secrets were ever set to the same value.
export type TokenTyp = 'access' | 'refresh' | 'reset';

const sign = (payload: object, secret: string, typ: TokenTyp, expiresIn: number) => {
  const { typ: _ignored, iat: _iat, exp: _exp, ...rest } = payload as Record<string, unknown>;
  return jwt.sign({ ...rest, typ }, secret, { expiresIn });
};

const verify = <T>(token: string, secret: string, typ: TokenTyp): T => {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, unknown>;
  if (!decoded || typeof decoded !== 'object' || decoded.typ !== typ) throw new jwt.JsonWebTokenError('wrong token type');
  return decoded as T;
};

export const generateAccessToken = (payload: IAuthJwtPayload) =>
  sign(payload, appConfig.accessTokenSecret, 'access', appConfig.accessTokenLifeSeconds);

export const generateRefreshToken = (payload: IAuthJwtPayload) =>
  sign(payload, appConfig.refreshTokenSecret, 'refresh', appConfig.refreshTokenLifeSeconds);


// JWT Verification Functions

export const verifyAccessToken = (token: string): IAuthJwtPayload =>
  verify<IAuthJwtPayload>(token, appConfig.accessTokenSecret, 'access');

export const verifyRefreshToken = (token: string): IAuthJwtPayload =>
  verify<IAuthJwtPayload>(token, appConfig.refreshTokenSecret, 'refresh');

