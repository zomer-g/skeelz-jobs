/* ============================================================================
 *  Internal API tokens — staff screen (routes are staffOnly: admin + content manager, see routes.ts):
 *   GET  /api/admin/api-tokens              all tokens' metadata (never the token or its hash)
 *   POST /api/admin/api-tokens              { name, scopes[], expiresInDays? } → the token, ONCE.
 *                                           People scopes (PEOPLE_SCOPES) only for a content manager (DB
 *                                           role); an admin asking for one gets 403, logged as access.denied.
 *   POST /api/admin/api-tokens/:id/revoke   any staff member, any token; effective on the next request
 *  Both writes are logged (api_token.created / api_token.revoked).
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import { query, queryOne } from '../config/db.js';
import { actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { isObjectId, newObjectId } from '../utils/ids.js';
import { SCOPES, TOKEN_DAYS, issuableScopes, mintToken, parseScopes, tokenActor, tokenDays, tokenState } from './pure.js';

const bad = (res: Response, message: string, status = 400) => res.status(status).json({ message, code: 'api_token_bad_request' });

const toView = (r: any) => ({
  id: r.id, name: r.name, prefix: r.prefix, actor: tokenActor(r.prefix), scopes: r.scopes,
  createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
  revokedAt: r.revoked_at, revokedBy: r.revoked_by, lastUsedAt: r.last_used_at,
  state: tokenState({ expiresAt: new Date(r.expires_at), revokedAt: r.revoked_at ? new Date(r.revoked_at) : null }),
});

export const listTokens = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(`SELECT id, name, prefix, scopes, created_by, created_at, expires_at, revoked_at, revoked_by, last_used_at
                                FROM api_tokens ORDER BY created_at DESC LIMIT 200`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      tokens: rows.map(toView),
      scopes: SCOPES,
      // What THIS caller may put on a new token (role from the DB, set by the gate).
      issuable: issuableScopes(req.authUser?.role),
      days: TOKEN_DAYS,
      secretEnabled: (process.env.INTERNAL_API_SECRET ?? '').length >= 32,
    } });
  } catch (e) { next(e); }
};

export const createToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) return bad(res, 'name is required (up to 80 characters)');
    const scopes = parseScopes(req.body?.scopes);
    if (!scopes) return bad(res, `scopes: one or more of ${Object.keys(SCOPES).join(', ')}`);
    // Separation of duties: the role comes from the DB (req.authUser, set by the gate), never from the request.
    const allowed = issuableScopes(req.authUser?.role);
    const refused = scopes.filter((sc) => !allowed.includes(sc));
    if (refused.length) {
      auditDenied(req, `api_token:scope_not_issuable:${refused.join(',')}`);
      return res.status(403).json({
        message: 'Only a content manager can issue a token that reads candidates, applications or CVs.',
        code: 'scope_not_issuable', scopes: refused,
      });
    }
    const days = tokenDays(req.body?.expiresInDays);
    if (!days) return bad(res, `expiresInDays: a whole number from 1 to ${TOKEN_DAYS.max}`);
    const { token, prefix, hash } = mintToken();
    const by = actorOf(req);
    const row = await queryOne(
      `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING *`,
      [newObjectId(), name, prefix, hash, scopes, by, days]
    );
    await writeAudit(by, 'api_token.created', tokenActor(prefix), { name, scopes, days, expires_at: row.expires_at });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ data: { token, ...toView(row) } });
  } catch (e) { next(e); }
};

export const revokeToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!isObjectId(id)) return bad(res, 'bad token id');
    const by = actorOf(req);
    const row = await queryOne(
      `UPDATE api_tokens SET revoked_at = now(), revoked_by = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING *`, [by, id]);
    if (!row) return bad(res, 'token not found or already revoked', 404);
    await writeAudit(by, 'api_token.revoked', tokenActor(row.prefix), { name: row.name });
    res.json({ data: toView(row) });
  } catch (e) { next(e); }
};
