/* ============================================================================
 *  Blocking a role of an account (owner, 24.11.2026; docs/security.md "Blocking a role"). Admins only.
 *
 *  An account may hold three kinds of role: candidate ('user'), employer, and one staff role ('staff'). An admin
 *  blocks each of them on its own — e.g. keep someone as a candidate but block them as an employer. A blocked role
 *  stays on the account (its data stays) but counts for nothing: no gate opens on it and no sign-in carries it
 *  (models/enums.ts usableRolesOf, read from the DB on every request). Blocking closes EVERY session of the account
 *  at once (and revokes the internal API keys it issued); the person signs in again with the roles still open to
 *  them. An account with no open role left can't sign in at all. The person can't add a blocked role back
 *  (rolesController, 403 role_blocked); only an admin unblocks it.
 *
 *   GET  /api/admin/role-blocks?email=…          find an account by its email (e.g. an employer, who is on no
 *                                               staff list): id, the kinds of role it holds, the blocked ones
 *   GET  /api/admin/role-blocks/:userId          the same by id (candidates screen, staff screen)
 *   PUT  /api/admin/role-blocks/:userId/:role    { blocked: true | false }  (role: user | employer | staff)
 *
 *  Nothing else about the person is returned. Lock-out: an admin can't block their own staff role, nor the staff role
 *  of the last admin who can act. Logged: users.role_blocked / users.role_unblocked (role and roles only, target the
 *  account id), users.role_blocks_viewed.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import { queryOne } from '../config/db.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { BlockableRole, blockableRolesHeld, blockedOf, isBlockableRole, isStaffRole, rolesOf, UserRole } from '../models/enums.js';
import { isObjectId } from '../utils/ids.js';
import { activeAdmins, closeSessions, serialized } from './staffController.js';

type Row = { id: string; email: string; role: string; roles: string[]; blocked_roles: string[]; deactivated_at: Date | null };
const COLS = `id, email, role, roles, blocked_roles, deactivated_at`;

const view = (r: Row) => ({
  id: r.id,
  // The kinds of role the account holds ('staff' for its staff role) and which of the three are blocked.
  roles: blockableRolesHeld(r),
  staffRole: rolesOf(r).find((x) => isStaffRole(x)) ?? null,
  blocked: blockedOf(r),
  active: !r.deactivated_at,
});

const notFound = (res: Response) => res.status(404).json({ message: 'No such account', code: 'account_not_found' });

const answer = async (req: Request, res: Response, r: Row | null, how: 'id' | 'email') => {
  if (!r) return notFound(res);
  void writeAudit(actorOf(req), 'users.role_blocks_viewed', r.id, { by: how });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ data: view(r) });
};

export const findByEmail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!email || email.length > 254 || !email.includes('@')) return res.status(400).json({ message: 'email is required', code: 'bad_email' });
    return answer(req, res, await queryOne<Row>(`SELECT ${COLS} FROM users WHERE lower(email) = $1`, [email]), 'email');
  } catch (e) { next(e); }
};

export const get = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.userId);
    if (!isObjectId(id)) return notFound(res);
    return answer(req, res, await queryOne<Row>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]), 'id');
  } catch (e) { next(e); }
};

const REFUSALS: Record<string, string> = {
  self_staff: 'אי אפשר לחסום את תפקיד הצוות של עצמך',
  last_admin: 'זהו מנהל המערכת הפעיל האחרון — קודם צריך למנות מנהל מערכת נוסף',
};

export const set = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.userId);
    const role = String(req.params.role);
    if (!isObjectId(id)) return notFound(res);
    if (!isBlockableRole(role)) return res.status(400).json({ message: 'role: user, employer or staff', code: 'bad_role' });
    if (typeof req.body?.blocked !== 'boolean') return res.status(400).json({ message: 'blocked: true or false', code: 'bad_value' });
    const blocked: boolean = req.body.blocked;
    const r = await serialized(async () => {
      const t = await queryOne<Row>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
      if (!t) return { status: 404 as const };
      const before = blockedOf(t);
      if (before.includes(role) === blocked) return { status: 200 as const, changed: false, t };
      if (blocked && role === 'staff') {
        if (t.id === req.authUser?.id) return { status: 409 as const, refusal: 'self_staff' };
        if (rolesOf(t).includes(UserRole.ADMIN) && !t.deactivated_at && (await activeAdmins()) <= 1) return { status: 409 as const, refusal: 'last_admin' };
      }
      const after: BlockableRole[] = blocked ? [...before, role] : before.filter((x) => x !== role);
      const row = await queryOne<Row>(`UPDATE users SET blocked_roles = $2::text[], updated_at = now() WHERE id = $1 RETURNING ${COLS}`, [id, after]);
      // Blocking: every session closed now (access tokens too) and the API keys it issued revoked; the person signs in
      // again with the roles still open to them. Unblocking adds nothing to a session until it is used (read per request).
      if (blocked) await closeSessions(req, id, 'issuer_role_blocked');
      await writeAudit(actorOf(req), blocked ? 'users.role_blocked' : 'users.role_unblocked', id, {
        role, roles: blockableRolesHeld(t), blocked_before: before, blocked_after: after, sessions_closed: blocked,
        self: id === req.authUser?.id,
      });
      return { status: 200 as const, changed: true, t: row! };
    });
    if (r.status === 404) return notFound(res);
    if (r.status === 409) return res.status(409).json({ message: REFUSALS[r.refusal!] ?? r.refusal, code: r.refusal });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: { ...view(r.t!), changed: r.changed } });
  } catch (e) { next(e); }
};

