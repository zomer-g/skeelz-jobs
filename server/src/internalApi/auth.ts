/* ============================================================================
 *  internalApiAuth(scopes) — the ONLY gate of /api/internal/v1 (server to server).
 *
 *  `Authorization: Bearer <x>` where x is either
 *   - a token issued on the security screen (stored as a SHA-256 hash; must be
 *     unexpired and not revoked), or
 *   - the server secret INTERNAL_API_SECRET (≥ 32 chars; unset = off), compared
 *     in constant time; it has every scope and acts as `system:internal-api`.
 *  Cookies and the user JWTs are never read here, and a user token gives nothing.
 *  A token stands only while its issuer does: refused when the issuer is
 *  deactivated, unknown, or their CURRENT DB role no longer allows the token's
 *  scopes (issuerRefusal). Its daily limits are the issuer's (budgetOwner).
 *  No caller → 401, missing scope → 403; every refusal goes to the activity log
 *  (access.denied, throttled). Tagged fn.gate = 'internalApi' for gates.test.mjs.
 * ========================================================================== */
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { query, queryOne } from '../config/db.js';
import { actorName, auditDenied } from '../security/audit.js';
import {
  ALL_SCOPES, issuerRefusal, SECRET_ACTOR, Scope, bearerOf, missingScopes, secretMatches, sha256, tokenActor, tokenPrefix, tokenState,
} from './pure.js';

type TokenRow = {
  id: string; name: string; prefix: string; scopes: string[]; expires_at: Date; revoked_at: Date | null; last_used_at: Date | null;
  issuer_id: string | null; issuer_email: string | null; issuer_role: string | null; issuer_deactivated_at: Date | null;
};

const refuse = (req: Request, res: Response, status: 401 | 403, code: string, reason: string) => {
  auditDenied(req, reason);
  if (status === 401) res.setHeader('WWW-Authenticate', `Bearer error="invalid_token"`);
  return res.status(status).json({ message: status === 401 ? 'Unauthorized' : 'Forbidden', code });
};

/** last_used_at, at most once a minute per token (not a write on every call). */
const touch = (row: TokenRow) => {
  if (row.last_used_at && Date.now() - new Date(row.last_used_at).getTime() < 60_000) return;
  void query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => undefined);
};

export const internalApiAuth = (scopes: Scope[]): RequestHandler => {
  const gate: RequestHandler & { gate?: string; scopes?: Scope[] } = async (req, res, next: NextFunction) => {
    try {
      const raw = bearerOf(req.get('authorization'));
      if (!raw) return refuse(req, res, 401, 'no_token', 'internal_api:no_token');

      if (secretMatches(raw, process.env.INTERNAL_API_SECRET)) {
        req.apiClient = { kind: 'secret', id: 'secret', name: 'INTERNAL_API_SECRET', scopes: [...ALL_SCOPES], actor: SECRET_ACTOR };
        return next();
      }

      const prefix = tokenPrefix(raw);
      const row = prefix
        ? await queryOne<TokenRow>(
          `SELECT t.id, t.name, t.prefix, t.scopes, t.expires_at, t.revoked_at, t.last_used_at,
                  u.id AS issuer_id, u.email AS issuer_email, u.role AS issuer_role, u.deactivated_at AS issuer_deactivated_at
             FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by_user_id
            WHERE t.token_hash = $1`, [sha256(raw)])
        : null;
      if (!row) return refuse(req, res, 401, 'invalid_token', 'internal_api:invalid_token');

      const client = { kind: 'token' as const, id: row.id, name: row.name, scopes: row.scopes, actor: tokenActor(row.prefix) };
      const state = tokenState({ expiresAt: new Date(row.expires_at), revokedAt: row.revoked_at ? new Date(row.revoked_at) : null });
      if (state !== 'active') {
        req.apiClient = client; // so the refusal is logged against this token
        return refuse(req, res, 401, `token_${state}`, `internal_api:token_${state}`);
      }
      // The issuer must still stand behind the token (role and state from the DB now).
      const issuer = row.issuer_id ? { role: row.issuer_role, deactivatedAt: row.issuer_deactivated_at } : null;
      const issuerProblem = issuerRefusal(issuer, row.scopes);
      if (issuerProblem) {
        req.apiClient = client;
        return refuse(req, res, 401, `token_${issuerProblem}`, `internal_api:token_${issuerProblem}`);
      }
      // Daily limits and alerts count against the person who issued the key, not per key.
      req.apiClient = { ...client, budgetOwner: actorName({ id: row.issuer_id!, email: row.issuer_email ?? '', role: row.issuer_role! }) };
      touch(row);
      const missing = missingScopes(row.scopes, scopes);
      if (missing.length) return refuse(req, res, 403, 'insufficient_scope', `internal_api:scope:${missing.join(',')}`);
      next();
    } catch (err) {
      next(err);
    }
  };
  gate.gate = 'internalApi';
  gate.scopes = scopes;
  return gate;
};
