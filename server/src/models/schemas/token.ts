import { TokenType } from '../enums.js';

export interface IToken {
  _id: string;
  userID: string;
  token: string;
  expiresAt: Date;
  type: TokenType;
  used: boolean;
  disabled: boolean;
}
