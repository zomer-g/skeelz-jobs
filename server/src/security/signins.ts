/* ============================================================================
 *  Sign-ins in the activity log (docs/security.md "Sign-ins").
 *
 *  auditLogin        every successful sign-in, every method and every role: auth.login with the role, the method,
 *                    the address (IP) and a short device summary (browser + OS family). Then the unusual-sign-in
 *                    checks: a staff account from a new address, many accounts from one address.
 *  signinContext     { ip, device } for the sign-up entries.
 *  signinFailed      a failed / refused attempt on a KNOWN account (details.account = user:<id>); on a staff
 *                    account it checks the burst of failures.
 *
 *  Alerts go to security_alerts (raiseAlert, once per kind + person + day) and show on the admin screen.
 *  Thresholds: SIGNIN_ALERTS (pure.ts). Nothing here prints personal data; the log keeps ids and the address.
 * ========================================================================== */
import { Request } from 'express';
import { query, queryOne } from '../config/db.js';
import { actorName, writeAudit } from './audit.js';
import { raiseAlert } from './limits.js';
import {
  AUDIT_RETENTION_MONTHS, SIGNIN_ALERTS, SIGNIN_FAILURE_ACTIONS, deviceSummary, effectiveRoles, isNewSigninAddress, isStaffRole, normalizeIp,
  reachedBurst, safeErrorText,
} from './pure.js';

import { rolesOf, usableRolesOf } from '../models/enums.js';
import { AuthErrorCodes } from '../i18n/i18n.js';

type Account = { _id?: any; id?: any; email?: string; role?: string; roles?: string[] };
const idOf = (u: Account) => String(u._id ?? u.id);
const actorOfAccount = (u: Account) => actorName({ id: idOf(u), email: String(u.email ?? ''), role: String(u.role ?? '') });

/** The address and device of a request, as the log keeps them. */
export const signinContext = (req: Request): { ip: string; device: string } => ({
  ip: normalizeIp(req.ip),
  device: deviceSummary(req.headers['user-agent']),
});

/** Addresses this account signed in from before (within the retention window; the log keeps no older entries). */
const knownAddresses = async (actor: string): Promise<string[]> => {
  const rows = await query<{ ip: string }>(
    `SELECT DISTINCT details->>'ip' AS ip FROM audit_log
      WHERE actor = $1 AND action = 'auth.login' AND details ? 'ip' AND at >= now() - make_interval(months => $2)
      LIMIT 500`, [actor, AUDIT_RETENTION_MONTHS]);
  return rows.map((r) => r.ip);
};

/** The refusal an issueSession error stands for: every role of the sign-in blocked by an admin, or deactivated. */
export const refusedAction = (e: unknown): 'auth.login_refused_blocked' | 'auth.login_refused_deactivated' =>
  (e as any)?.code === AuthErrorCodes.ROLES_BLOCKED ? 'auth.login_refused_blocked' : 'auth.login_refused_deactivated';

/** Writes auth.login (role, method, address, device) and runs the unusual-sign-in checks. Never breaks the sign-in. */
export const auditLogin = (req: Request, user: Account, method: string, extra: Record<string, unknown> = {}): void => {
  const ctx = signinContext(req);
  const actor = actorOfAccount(user);
  const role = String(user.role ?? '');
  // The roles this session carries (several per account since 23.11.2026; staff roles only on Google).
  const roles = effectiveRoles(usableRolesOf(user as any), method); // blocked roles (24.11.2026) never count
  void (async () => {
    try {
      const staff = roles.some((r) => isStaffRole(r));
      const known = staff && ctx.ip ? await knownAddresses(actor) : [];
      await writeAudit(actor, 'auth.login', null, { role, roles, method, ...extra, ip: ctx.ip || null, device: ctx.device });
      if (staff && isNewSigninAddress(ctx.ip, known)) {
        await raiseAlert('signin_new_address', actor, 0, { ip: ctx.ip, device: ctx.device, method, known: known.length });
      }
      if (ctx.ip) await checkAddress(ctx.ip);
    } catch (e) {
      console.error(`[signins] checks failed: ${safeErrorText(e)}`);
    }
  })();
};

/** Many different accounts signed in from one address within the window. */
const checkAddress = async (ip: string) => {
  const { count, windowMinutes } = SIGNIN_ALERTS.accountsPerAddress;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT actor)::int AS n FROM audit_log
      WHERE action = 'auth.login' AND at >= now() - make_interval(mins => $2) AND details @> jsonb_build_object('ip', $1::text)`,
    [ip, windowMinutes]);
  if (reachedBurst(row?.n ?? 0, count)) {
    await raiseAlert('signin_many_accounts', `address:${ip}`, count, { ip, accounts: row?.n ?? 0, window_minutes: windowMinutes });
  }
};

/**
 * A failed or refused sign-in on a known account. Writes the entry (with details.account, the address and device)
 * and, on a staff account, raises an alert at a burst of failures within the window.
 */
export const signinFailed = (req: Request, actor: string, action: string, account: Account | null, details: Record<string, unknown> = {}, target: string | null = null): void => {
  const ctx = signinContext(req);
  const ref = account ? `user:${idOf(account)}` : null;
  void (async () => {
    try {
      await writeAudit(actor, action, target, { ...details, ...(ref ? { account: ref } : {}), ip: ctx.ip || null, device: ctx.device });
      if (account && ref && isStaffRole(String(account.role ?? ''))) await checkStaffFailures(account, ref);
    } catch (e) {
      console.error(`[signins] failure check failed: ${safeErrorText(e)}`);
    }
  })();
};

const checkStaffFailures = async (account: Account, ref: string) => {
  const { count, windowMinutes } = SIGNIN_ALERTS.staffFailures;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM audit_log
      WHERE action = ANY($2) AND at >= now() - make_interval(mins => $3)
        AND (details @> jsonb_build_object('account', $1::text) OR left(target, 1000) = $1)`,
    [ref, SIGNIN_FAILURE_ACTIONS, windowMinutes]);
  if (reachedBurst(row?.n ?? 0, count)) {
    await raiseAlert('signin_failures_staff', actorOfAccount(account), count, { failures: row?.n ?? 0, window_minutes: windowMinutes, account: ref });
  }
};
