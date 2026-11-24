/* ============================================================================
 *  Staff users (admins only, see routes.ts). Separation of duties:
 *    placement_coordinator  sees candidates (view only) and manages jobs, within daily limits
 *    content_manager  jobs and candidates (lists, applications, CVs), settings, within daily limits
 *    admin            everything a content manager does, plus security and this screen
 *
 *  Several roles per account (owner, 23.11.2026): one account may be a candidate, an employer AND hold one staff
 *  role. This screen manages only the staff role; a candidate / employer role the account holds stays.
 *
 *   GET   /api/admin/staff                          accounts holding a staff role (plus "also a candidate /
 *                                                   employer" flags, never their data)
 *   POST  /api/admin/staff                          { email, role, firstName?, lastName? }:
 *                                                   an existing account (candidate, employer, staff) gets the
 *                                                   staff role ADDED (its other roles stay), else an account
 *                                                   without a password is created and invited
 *   PATCH /api/admin/staff/:userId/role             { role: user | placement_coordinator | content_manager | admin }:
 *                                                   the account's one staff role is replaced; 'user' = remove
 *                                                   staff access (an account left with no role becomes a
 *                                                   candidate, as before)
 *   POST  /api/admin/staff/:userId/deactivate       can't sign in; sessions closed
 *   POST  /api/admin/staff/:userId/activate
 *   POST  /api/admin/staff/:userId/revoke-sessions  every session closed now (access tokens too)
 *
 *  Lock-out: the last active admin can't be demoted or deactivated, nobody deactivates themself
 *  (staffChangeRefusal in security/pure.ts). Changes run one at a time. Every change is logged
 *  (staff.*, with the roles before / after) with emails of staff only, never a candidate's details. The admin never
 *  sets or sees a password: staff powers count only on a "Continue with Google" (xhostd SSO) session, matched by
 *  email on first use. An invite is a plain email saying so; "invite pending" = never signed in with SSO yet.
 * ========================================================================== */
import { Request, Response, NextFunction } from 'express';
import { query, queryOne } from '../config/db.js';
import { ASSIGNABLE_ROLES, REVIEWED_ROLES, StaffChange, staffChangeRefusal } from '../security/pure.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { invalidateTokens } from '../services/tokenStorageService.js';
import { TokenType, UserRole, blockedOf, rolesOf } from '../models/enums.js';
import { isObjectId, newObjectId } from '../utils/ids.js';
import { mailStaffInvite } from '../mail/triggers.js';
import appConfig from '../config/appConfig.js';
import { safeErrorText } from '../security/pure.js';
import { revokeTokensOf } from '../internalApi/tokensController.js';

type Target = { id: string; email: string; role: string; roles: string[]; deactivated_at: Date | null };
type Result = { status: number; message: string; data?: Record<string, unknown> };

/** The account's staff role, or 'user' when it has none (what the lock-out rules and the screen compare). */
const staffRoleOf = (t: Pick<Target, 'role' | 'roles'>): string => rolesOf(t).find((r) => REVIEWED_ROLES.includes(r)) ?? 'user';
/** The roles after setting the staff role to `to` ('user' = none): the other roles stay; never an empty set. */
const rolesWith = (t: Pick<Target, 'role' | 'roles'>, to: string): string[] => {
  const others: string[] = rolesOf(t).filter((r) => !REVIEWED_ROLES.includes(r));
  const next = to === 'user' ? others : [...others, to];
  return next.length ? next : ['user'];
};

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
export const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
};

/** Admins who can act: active and their staff role not blocked (24.11.2026). */
export const activeAdmins = async () =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE 'admin' = ANY(roles) AND deactivated_at IS NULL
                                   AND NOT ('staff' = ANY(blocked_roles))`))?.n ?? 0;

const loadTarget = (userId: string) =>
  queryOne<Target>(`SELECT id, email, role, roles, deactivated_at FROM users WHERE id = $1`, [userId]);

const refuse = async (req: Request, target: Target, change: StaffChange) => staffChangeRefusal({
  actorId: req.authUser!.id,
  target: { id: target.id, role: staffRoleOf(target), active: !target.deactivated_at },
  change,
  activeAdmins: await activeAdmins(),
});

/** Every session of the person closed now, and every internal API key they issued revoked (logged, with why). */
export const closeSessions = async (req: Request, userId: string, reason: Parameters<typeof revokeTokensOf>[2]) => {
  await query(`UPDATE users SET sessions_revoked_at = now() WHERE id = $1`, [userId]);
  await invalidateTokens(userId, TokenType.REFRESH_TOKEN);
  await revokeTokensOf(userId, actorOf(req), reason);
};

const applyRole = async (req: Request, target: Target, to: string, action: string): Promise<Result> => {
  const refusal = await refuse(req, target, { kind: 'role', to });
  if (refusal === 'no_change') return { status: 200, message: 'no change', data: { changed: false } };
  if (refusal) return { status: refusal === 'bad_role' ? 400 : 409, message: REFUSAL_TEXT[refusal] ?? refusal };
  // Only the staff role changes; a candidate / employer role the account holds stays.
  const roles = rolesWith(target, to);
  // Staff sign in only with SSO: a promoted account loses any password it had (a password someone else may know).
  await query(`UPDATE users SET roles = $1::text[], password = CASE WHEN $3 THEN '' ELSE password END, updated_at = now() WHERE id = $2`,
    [roles, target.id, REVIEWED_ROLES.includes(to)]);
  // Effective at once: the roles are read from the DB on every request; sessions are closed and API keys revoked too.
  await closeSessions(req, target.id, 'issuer_role_changed');
  await writeAudit(actorOf(req), action, target.email.toLowerCase(), {
    from: staffRoleOf(target), to, roles_before: rolesOf(target), roles_after: roles, self: target.id === req.authUser?.id,
  });
  return { status: 200, message: 'ok', data: { changed: true } };
};

/**
 * Changes the staff role of an account by id (also used by the security screen's "remove access").
 * `staffOnly`: the target must currently hold a staff role — admins work with staff ids, never candidates'.
 */
export const changeStaffRole = (req: Request, userId: string, to: string, action: string, opts: { staffOnly?: boolean } = {}) =>
  serialized(async (): Promise<Result> => {
    const target = await loadTarget(userId);
    if (!target || (opts.staffOnly && staffRoleOf(target) === 'user')) return { status: 404, message: 'not a staff member' };
    return applyRole(req, target, to, action);
  });

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query<{ id: string; email: string; first_name: string; last_name: string; role: string; roles: string[];
      blocked_roles: string[]; created_at: Date; deactivated_at: Date | null; has_sso: boolean }>(
      `SELECT id, email, first_name, last_name, role, roles, blocked_roles, created_at, deactivated_at, xhostd_sub IS NOT NULL AS has_sso
         FROM users WHERE roles && $1::text[] ORDER BY deactivated_at IS NOT NULL, role, email`, [REVIEWED_ROLES]);
    const logins = await query<{ actor: string; at: Date }>(
      `SELECT actor, max(at) AS at FROM audit_log WHERE action = 'auth.login' AND actor = ANY($1) GROUP BY actor`,
      [rows.map((r) => r.email.toLowerCase())]);
    const lastLogin = new Map(logins.map((l) => [l.actor, l.at]));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      roles: ASSIGNABLE_ROLES,
      me: req.authUser?.id,
      staff: rows.map((r) => ({
        id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name, role: staffRoleOf(r),
        // Other roles the person holds too: a note on the screen, never their candidate / employer data.
        alsoCandidate: rolesOf(r).includes(UserRole.USER), alsoEmployer: rolesOf(r).includes(UserRole.EMPLOYER),
        // Roles an admin blocked ('user' | 'employer' | 'staff', 24.11.2026; roleBlocksController).
        blocked: blockedOf(r),
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
    if (!REVIEWED_ROLES.includes(role)) return bad(res, 'אפשר להוסיף רכז השמה, מנהל תוכן או מנהל מערכת');
    const result = await serialized(async (): Promise<Result> => {
      const existing = await queryOne<Target>(`SELECT id, email, role, roles, deactivated_at FROM users WHERE lower(email) = $1`, [email]);
      // An existing account (a candidate, an employer, staff) gets the staff role ADDED; its other roles and its data
      // stay (owner, 23.11.2026). Staff powers count only on a Google session; its candidate data reaches other staff
      // only through the hand-overs, like any candidate's.
      if (existing) {
        const r = await applyRole(req, existing, role, 'staff.role_changed');
        // The invite goes out when the account BECOMES staff (it was a candidate / an employer); a staff member whose
        // staff role only changes gets no invite (docs/mail.md).
        const becameStaff = r.status === 200 && r.data?.changed === true && staffRoleOf(existing) === 'user';
        return r.status === 200
          ? { ...r, data: { ...r.data, created: false, becameStaff, alsoCandidate: rolesOf(existing).includes(UserRole.USER), alsoEmployer: rolesOf(existing).includes(UserRole.EMPLOYER) } }
          : r;
      }
      const id = newObjectId();
      await query(
        `INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, roles, has_applied_to_job)
         VALUES ($1, $2, $3, $4, $5, '', -1, '', ARRAY[$6]::text[], false)`,
        [id, firstName, lastName, email, `staff-${id}`, role]);
      await writeAudit(actorOf(req), 'staff.invited', email, { role });
      return { status: 200, message: 'ok', data: { created: true, becameStaff: true, changed: true } };
    });
    if (result.status === 200 && result.data?.becameStaff) {
      // Staff have no password: the invite only tells them to sign in with "Continue with Google" (xhostd SSO).
      let emailSent = false;
      try {
        const r = await mailStaffInvite(email, role);
        emailSent = r.status === 'sent';
        if (!emailSent) console.info(`[staff] invite email not sent status=${r.status}${r.error ? ` code=${r.error}` : ''}`);
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
  return t && staffRoleOf(t) !== 'user' ? t : null;
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
      await closeSessions(req, target.id, 'issuer_deactivated');
      await writeAudit(actorOf(req), 'staff.deactivated', target.email.toLowerCase(), { role: staffRoleOf(target) });
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
      await writeAudit(actorOf(req), 'staff.reactivated', target.email.toLowerCase(), { role: staffRoleOf(target) });
      return { status: 200, message: 'ok', data: { changed: true } };
    }));
  } catch (e) { next(e); }
};

export const revokeSessions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await staffById(String(req.params.userId));
    if (!target) return bad(res, 'not a staff member', 404);
    await closeSessions(req, target.id, 'issuer_sessions_revoked');
    await writeAudit(actorOf(req), 'staff.sessions_revoked', target.email.toLowerCase(), {
      role: staffRoleOf(target), self: target.id === req.authUser?.id,
    });
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
};
