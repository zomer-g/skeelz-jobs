/* ============================================================================
 *  Staff users (admins only, see routes.ts). Separation of duties:
 *    content_manager  jobs and candidates (lists, applications, CVs), within daily limits
 *    admin            security screen and this screen; sees no candidates
 *
 *   GET   /api/admin/staff                          staff accounts (never candidates)
 *   POST  /api/admin/staff                          { email, role, firstName?, lastName? }:
 *                                                   an existing account gets the role, else an account
 *                                                   without a password is created and invited
 *   PATCH /api/admin/staff/:userId/role             { role: user | content_manager | admin }
 *   POST  /api/admin/staff/:userId/deactivate       can't sign in; sessions closed
 *   POST  /api/admin/staff/:userId/activate
 *   POST  /api/admin/staff/:userId/revoke-sessions  every session closed now (access tokens too)
 *
 *  Lock-out: the last active admin can't be demoted or deactivated, nobody deactivates themself
 *  (staffChangeRefusal in security/pure.ts). Changes run one at a time. Every change is logged
 *  (staff.*) with emails of staff only, never a candidate's details. The admin never sets or sees
 *  a password: staff sign in only with "Continue with Google" (xhostd SSO), matched by email on first use.
 *  An invite is a plain email saying so; "invite pending" = never signed in with SSO yet.
 * ========================================================================== */
import { Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../config/db.js';
import { ASSIGNABLE_ROLES, REVIEWED_ROLES, StaffChange, staffChangeRefusal } from '../security/pure.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { invalidateTokens } from '../services/tokenStorageService.js';
import { TokenType } from '../models/enums.js';
import { isObjectId, newObjectId } from '../utils/ids.js';
import { sendEmail } from '../services/emailService.js';
import { generateStaffInviteEmail } from '../utils/emailTemplates.js';
import appConfig from '../config/appConfig.js';
import { safeErrorText } from '../security/pure.js';

type Target = { id: string; email: string; role: string; deactivated_at: Date | null };
type Result = { status: number; message: string; data?: Record<string, unknown> };

const bad = (res: Response, message: string, status = 400) => res.status(status).json({ message, code: 'staff_bad_request' });
const send = (res: Response, r: Result) =>
  r.status === 200 ? res.json({ data: { ok: true, ...(r.data ?? {}) } }) : bad(res, r.message, r.status);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const REFUSAL_TEXT: Record<string, string> = {
  bad_role: 'תפקיד לא מוכר',
  last_admin: 'זהו מנהל המערכת הפעיל האחרון — קודם צריך למנות מנהל מערכת נוסף',
  self_deactivate: 'אי אפשר להשבית את החשבון של עצמך',
};

// One staff change at a time, so two admins can't demote each other into "no admin".
let chain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
};

const activeAdmins = async () =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND deactivated_at IS NULL`))?.n ?? 0;

const loadTarget = (userId: string) =>
  queryOne<Target>(`SELECT id, email, role, deactivated_at FROM users WHERE id = $1`, [userId]);

const refuse = async (req: Request, target: Target, change: StaffChange) => staffChangeRefusal({
  actorId: req.authUser!.id,
  target: { id: target.id, role: target.role, active: !target.deactivated_at },
  change,
  activeAdmins: await activeAdmins(),
});

const closeSessions = async (userId: string) => {
  await query(`UPDATE users SET sessions_revoked_at = now() WHERE id = $1`, [userId]);
  await invalidateTokens(userId, TokenType.REFRESH_TOKEN);
};

const applyRole = async (req: Request, target: Target, to: string, action: string): Promise<Result> => {
  const refusal = await refuse(req, target, { kind: 'role', to });
  if (refusal === 'no_change') return { status: 200, message: 'no change', data: { changed: false } };
  if (refusal) return { status: refusal === 'bad_role' ? 400 : 409, message: REFUSAL_TEXT[refusal] ?? refusal };
  await query(`UPDATE users SET role = $1, updated_at = now() WHERE id = $2`, [to, target.id]);
  // Effective at once: the role is read from the DB on every request; sessions are closed too.
  await closeSessions(target.id);
  await writeAudit(actorOf(req), action, target.email.toLowerCase(), {
    from: target.role, to, self: target.id === req.authUser?.id,
  });
  return { status: 200, message: 'ok', data: { changed: true } };
};

/**
 * Changes the role of a staff account by id (also used by the security screen's "remove access").
 * `staffOnly`: the target must currently be staff — admins work with staff ids, never candidates'.
 */
export const changeStaffRole = (req: Request, userId: string, to: string, action: string, opts: { staffOnly?: boolean } = {}) =>
  serialized(async (): Promise<Result> => {
    const target = await loadTarget(userId);
    if (!target || (opts.staffOnly && !REVIEWED_ROLES.includes(target.role))) return { status: 404, message: 'not a staff member' };
    return applyRole(req, target, to, action);
  });

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query<{ id: string; email: string; first_name: string; last_name: string; role: string;
      created_at: Date; deactivated_at: Date | null; has_sso: boolean }>(
      `SELECT id, email, first_name, last_name, role, created_at, deactivated_at, xhostd_sub IS NOT NULL AS has_sso
         FROM users WHERE role = ANY($1) ORDER BY deactivated_at IS NOT NULL, role, email`, [REVIEWED_ROLES]);
    const logins = await query<{ actor: string; at: Date }>(
      `SELECT actor, max(at) AS at FROM audit_log WHERE action = 'auth.login' AND actor = ANY($1) GROUP BY actor`,
      [rows.map((r) => r.email.toLowerCase())]);
    const lastLogin = new Map(logins.map((l) => [l.actor, l.at]));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      roles: ASSIGNABLE_ROLES,
      me: req.authUser?.id,
      staff: rows.map((r) => ({
        id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, role: r.role,
        active: !r.deactivated_at, deactivatedAt: r.deactivated_at, createdAt: r.created_at,
        invitePending: !r.has_sso, lastLogin: lastLogin.get(r.email.toLowerCase()) ?? null,
      })),
    } });
  } catch (e) { next(e); }
};

export const add = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = String(req.body?.role ?? '');
    const firstName = String(req.body?.firstName ?? '').trim().slice(0, 80);
    const lastName = String(req.body?.lastName ?? '').trim().slice(0, 80);
    if (!EMAIL_RE.test(email)) return bad(res, 'כתובת מייל לא תקינה');
    if (!REVIEWED_ROLES.includes(role)) return bad(res, 'אפשר להוסיף מנהל תוכן או מנהל מערכת');
    const result = await serialized(async (): Promise<Result> => {
      const existing = await queryOne<Target>(`SELECT id, email, role, deactivated_at FROM users WHERE lower(email) = $1`, [email]);
      if (existing) {
        const r = await applyRole(req, existing, role, 'staff.role_changed');
        return r.status === 200 ? { ...r, data: { ...r.data, created: false } } : r;
      }
      const id = newObjectId();
      await query(
        `INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, role, has_applied_to_job)
         VALUES ($1, $2, $3, $4, $5, '', -1, '', $6, false)`,
        [id, firstName, lastName, email, `staff-${id}`, role]);
      await writeAudit(actorOf(req), 'staff.invited', email, { role });
      return { status: 200, message: 'ok', data: { created: true, changed: true } };
    });
    if (result.status === 200 && result.data?.created) {
      // Staff have no password: the invite only tells them to sign in with "Continue with Google" (xhostd SSO).
      let emailSent = false;
      try {
        const { subject, text } = generateStaffInviteEmail(role);
        await sendEmail(email, subject, text);
        emailSent = !appConfig.sendEmailDisabled;
      } catch (e) {
        console.error('[staff] invite email failed', safeErrorText(e));
      }
      result.data = { ...result.data, emailSent };
    }
    send(res, result);
  } catch (e) { next(e); }
};

export const setRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId);
    if (!isObjectId(userId)) return bad(res, 'bad user id');
    send(res, await changeStaffRole(req, userId, String(req.body?.role ?? ''), 'staff.role_changed', { staffOnly: true }));
  } catch (e) { next(e); }
};

const staffById = async (userId: string) => {
  if (!isObjectId(userId)) return null;
  const t = await loadTarget(userId);
  return t && REVIEWED_ROLES.includes(t.role) ? t : null;
};

export const deactivate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    send(res, await serialized(async (): Promise<Result> => {
      const target = await staffById(String(req.params.userId));
      if (!target) return { status: 404, message: 'not a staff member' };
      const refusal = await refuse(req, target, { kind: 'deactivate' });
      if (refusal === 'no_change') return { status: 200, message: 'no change', data: { changed: false } };
      if (refusal) return { status: 409, message: REFUSAL_TEXT[refusal] ?? refusal };
      await query(`UPDATE users SET deactivated_at = now(), updated_at = now() WHERE id = $1`, [target.id]);
      await closeSessions(target.id);
      await writeAudit(actorOf(req), 'staff.deactivated', target.email.toLowerCase(), { role: target.role });
      return { status: 200, message: 'ok', data: { changed: true } };
    }));
  } catch (e) { next(e); }
};

export const activate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    send(res, await serialized(async (): Promise<Result> => {
      const target = await staffById(String(req.params.userId));
      if (!target) return { status: 404, message: 'not a staff member' };
      if (!target.deactivated_at) return { status: 200, message: 'no change', data: { changed: false } };
      await query(`UPDATE users SET deactivated_at = NULL, updated_at = now() WHERE id = $1`, [target.id]);
      await writeAudit(actorOf(req), 'staff.reactivated', target.email.toLowerCase(), { role: target.role });
      return { status: 200, message: 'ok', data: { changed: true } };
    }));
  } catch (e) { next(e); }
};

export const revokeSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await staffById(String(req.params.userId));
    if (!target) return bad(res, 'not a staff member', 404);
    await closeSessions(target.id);
    await writeAudit(actorOf(req), 'staff.sessions_revoked', target.email.toLowerCase(), {
      role: target.role, self: target.id === req.authUser?.id,
    });
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
};
