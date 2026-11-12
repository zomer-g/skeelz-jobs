import * as tokenDAL from '../dal/tokenDAL.js';
import * as tokenUtilityService from './tokenUtilityService.js'
import { TokenType } from '../models/enums.js';
import { IToken } from '../models/schemas/token.js';

export const createToken = async (userID: string, token: string, expiresIn: number, type: TokenType): Promise<IToken> => {
    // Disable existing Tokens for the same userID and type
    await tokenDAL.disableExistingTokens(userID, type);
    const hashedToken = tokenUtilityService.hashTokenWithSalt(token);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    return await tokenDAL.createToken(userID, hashedToken, expiresAt, type);
  };
  
  export const invalidateTokens = async (userID: string, tokenType: TokenType) => {
    await tokenDAL.disableExistingTokens(userID, tokenType);
  }
  
  export const findActiveToken = async (userID: string, type: TokenType): Promise<IToken | null> => {
    return await tokenDAL.findActiveToken(userID, type);
  };
  
  export const findActiveUnusedToken = async (userID: string, type: TokenType): Promise<IToken | null> => {
    return await tokenDAL.findActiveUnusedToken(userID, type);
  };
  
  export const markTokenAsUsed = async (_id: string): Promise<void> => {
    await tokenDAL.markTokenAsUsed(_id);
  };
  