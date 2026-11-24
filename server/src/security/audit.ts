/* ============================================================================
 *  The activity log (audit_log): who did what, and who saw which candidate.
 *
 *  writeAudit        informational (a login, a page of jobs). Never breaks the
 *                    request; every failure is counted and shown to admins.
 *  writeAuditStrict  anything that HANDS OVER candidates' personal data (a CV,
 *                    a candidates list, someone's applications, a data export).
 *                    Written BEFORE the data leaves; it throws, and the caller
 *                    refuses (503). No record → no hand-over.
 *
 *  The table is append-only in the database (trigger in config/db.ts) and kept
 *  AUDIT_RETENTION_MONTHS; purgeAudit runs on its own timer (index.ts).
 *  Never put secrets or passwords in `details`.
 * ========================================================================== */
import crypto from 'crypto';
import { Request } from 'express';
import { query } from '../config/db.js';
import { AUDIT_RETENTION_MONTHS, REVIEWED_ROLES, safeErrorText } from './pure.js';

export class AuditWriteError extends Error {
  constructor() { super('activity log unavailable'); this.name = 'AuditWriteError'; }
}

/** Failures of informational writes since boot (shown in the admin banner). */
export const auditFailures = { count: 0, last: null as Date | null, lastAction: '' };

// Test hook: lets the tests make every insert fail (hand-over strictness).
let failAll = false;
export const __setAuditFailForTests = (v: boolean) => { failAll = v && process.env.NODE_ENV !== 'production'; };

const insert = async (actor: string, action: string, target?: string | null, details?: Record<string, unknown> | null) => {
  if (failAll) throw new Error('audit insert disabled for test');
  await query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)`,
    [actor.slice(0, 320), action, target ? String(target).slice(0, 2000) : null, details ? JSON.stringify(details) : null]);
};

export const writeAudit = async (actor: string, action: string, target?: string | null, details?: Record<string, unknown> | null) => {
  try {
    await insert(actor, action, target, details);
  } catch (e) {
    auditFailures.count++; auditFailures.last = new Date(); auditFailures.lastAction = action;
    console.error(`[audit] write failed (${action}): ${safeErrorText(e)}`);
  }
};

export const writeAuditStrict = async (actor: string, action: string, target?: string | null, details?: Record<string, unknown> | null) => {
  try {
    await insert(actor, action, target, details);
  } catch (e) {
    auditFailures.count++; auditFailures.last = new Date(); auditFailures.lastAction = action;
    console.error(`[audit] strict write failed (${action}): ${safeErrorText(e)}`);
    throw new AuditWriteError();
  }
};

/** How an account is written in the log: staff (admin, content manager) by email, a candidate as user:<id>. */
export const actorName = (u: { id: string; email: string; role: string }): string =>
  REVIEWED_ROLES.includes(u.role) ? u.email.toLowerCase() : `user:${u.id}`;

/** The person behind a request, as written in the log: an internal API client (token:<prefix> /
 *  system:internal-api), a staff email, else user:<id>, else the address. */
export const actorOf = (req: Request): string => {
  if (req.apiClient) return req.apiClient.actor;
  const u = req.authUser;
  if (u) return actorName(u);
  return `anonymous:${req.ip ?? 'unknown'}`;
};

/**
 * How an email someone TYPED (sign-in, password reset) is written in the log: the account as user:<id> when it
 * exists, else a short keyed hash (email#<12 hex>, HMAC with a server secret) — the same typed address gives the
 * same value, so repeated attempts can still be seen, but the address itself is not stored.
 */
export const typedEmailRef = (email: string, userId?: string | null): string => {
  if (userId) return `user:${userId}`;
  const key = `${process.env.RESET_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET || 'skeelz'}:audit-typed-email`;
  return `email#${crypto.createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
};

/**
 * How an uploaded CV is written in the log: upload#<12 hex>, a keyed hash of its storage key. The key itself is never
 * logged (it holds the upload token and the file's name, which can carry the candidate's name). The same file gives the
 * same value in its cv.uploaded and cv.attached entries, so one can follow it from the upload to its owner.
 */
export const uploadRef = (key: string): string => {
  const secret = `${process.env.RESET_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET || 'skeelz'}:audit-upload`;
  return `upload#${crypto.createHmac('sha256', secret).update(String(key)).digest('hex').slice(0, 12)}`;
};

/** Refusals are on record, throttled (once per actor + place + 10 minutes), so a probe can't flood the log. */
const deniedSeen = new Map<string, number>();
export const auditDenied = (req: Request, reason: string) => {
  const actor = actorOf(req);
  const place = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const key = `${actor}|${place}|${reason}`;
  const now = Date.now();
  if ((deniedSeen.get(key) ?? 0) > now - 10 * 60_000) return;
  deniedSeen.set(key, now);
  if (deniedSeen.size > 5000) for (const [k, t] of deniedSeen) if (t < now - 10 * 60_000) deniedSeen.delete(k);
  void writeAudit(actor, 'access.denied', place, { reason });
};

/** Nightly retention: deletes log entries (and companion rows) older than the retention period. */
export const purgeAudit = async () => {
  const m = AUDIT_RETENTION_MONTHS;
  const a = await query(`DELETE FROM audit_log WHERE at < now() - make_interval(months => $1) RETURNING id`, [m]);
  await query(`DELETE FROM security_alerts WHERE created_at < now() - make_interval(months => $1)`, [m]);
  await query(`DELETE FROM quota_grants WHERE created_at < now() - make_interval(months => $1)`, [m]);
  await query(`DELETE FROM access_reviews WHERE reviewed_at < now() - make_interval(months => $1)`, [m]);
  return a.length;
};
