import { query, queryOne } from '../config/db.js';
import { IToken } from '../models/schemas/token.js';
import { TokenType } from '../models/enums.js';
import { newObjectId } from '../utils/ids.js';

const SELECT = `id AS "_id", user_id AS "userID", token, expires_at AS "expiresAt", type, used, disabled`;

export const createToken = async (userID: string, hashedToken: string, expiresAt: Date, type: TokenType): Promise<IToken> => {
  const rows = await query<IToken>(
    `INSERT INTO tokens (id, user_id, token, expires_at, type) VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT}`,
    [newObjectId(), String(userID), hashedToken, expiresAt, type]
  );
  return rows[0];
};

export const findActiveToken = async (userID: string, type: TokenType): Promise<IToken | null> => {
  return queryOne<IToken>(
    `SELECT ${SELECT} FROM tokens WHERE user_id = $1 AND type = $2 AND disabled = false ORDER BY created_at DESC LIMIT 1`,
    [String(userID), type]
  );
};

export const findActiveUnusedToken = async (userID: string, type: TokenType): Promise<IToken | null> => {
  return queryOne<IToken>(
    `SELECT ${SELECT} FROM tokens WHERE user_id = $1 AND type = $2 AND disabled = false AND used = false ORDER BY created_at DESC LIMIT 1`,
    [String(userID), type]
  );
};

export const markTokenAsUsed = async (id: string): Promise<void> => {
  await query(`UPDATE tokens SET used = true WHERE id = $1`, [id]);
};

export const disableExistingTokens = async (userID: string, type: TokenType): Promise<void> => {
  await query(`UPDATE tokens SET disabled = true WHERE user_id = $1 AND type = $2 AND disabled = false`, [String(userID), type]);
  // Housekeeping: drop tokens that can no longer be used.
  await query(`DELETE FROM tokens WHERE user_id = $1 AND (disabled = true OR expires_at < now()) AND created_at < now() - interval '1 day'`, [String(userID)]);
};
