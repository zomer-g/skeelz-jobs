/* ============================================================================
 *  Admin security screen (all routes admin-only, see routes.ts). Admins oversee
 *  the content managers who see candidates; they see no candidate data here
 *  themselves (the log holds candidate ids, never their details).
 *   GET  /api/admin/security                    banner + screen: alerts, usage today, reviews, log failures
 *   POST /api/admin/security/grant              { email, budget } → +grant for today (content managers only)
 *   POST /api/admin/security/alerts/:id/handle  mark an alert handled
 *   POST /api/admin/security/reviews/:userId    confirm a staff member still needs access (60 days)
 *   POST /api/admin/security/admins/:userId/revoke  staff → candidate role, sessions closed (not the last admin)
 *   GET  /api/admin/audit?subject=&actor=&action=&before=  the activity log / "who saw X"
 *   GET  /api/admin/audit/person?who=&group=&before=       everything one account did (sign-ins with address + device, …)
 *  Every action here is itself recorded. Staff users: staffController.ts.
 * ========================================================================== */
import { Request, Response, NextFunction } from 'express';
import { escapeLike, query, queryOne } from '../config/db.js';
import { VIEWER_ROLES } from '../models/enums.js';
import { LIMITS, BUDGET_ACTIONS, GRANTABLE_BUDGETS, REVIEW, REVIEWED_ROLES, israelDay, israelMidnight, nextValidUntil, reviewState, Budget } from '../security/pure.js';
import { AuditWriteError, actorOf, auditFailures, writeAudit, writeAuditStrict } from '../security/audit.js';
import { dailyUsage } from '../security/limits.js';
import { changeStaffRole } from './staffController.js';
import { isObjectId } from '../utils/ids.js';

const bad = (res: Response, message: string, status = 400) => res.status(status).json({ message, code: 'security_bad_request' });

/** Active staff (admins and content managers) with the state of their access review. */
export const staffWithReviews = async () => {
  const admins = await query<{ id: string; email: string; role: string; created_at: Date }>(
    `SELECT id, email, role, created_at FROM users WHERE role = ANY($1) AND deactivated_at IS NULL ORDER BY role, email`,
    [REVIEWED_ROLES]);
  const reviews = await query<{ user_id: string; reviewed_by: string; role_at_review: string; reviewed_at: Date; valid_until: Date }>(
    `SELECT DISTINCT ON (user_id) user_id, reviewed_by, role_at_review, reviewed_at, valid_until
       FROM access_reviews ORDER BY user_id, reviewed_at DESC`);
  const byUser = new Map(reviews.map((r) => [r.user_id, r]));
  return admins.map((a) => {
    const r = byUser.get(a.id);
    const state = reviewState(r ? { validUntil: new Date(r.valid_until), roleAtReview: r.role_at_review } : null, a.role);
    return { id: a.id, email: a.email, role: a.role, review: r ? { by: r.reviewed_by, at: r.reviewed_at, validUntil: r.valid_until } : null, state };
  });
};

export const summary = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const day = israelDay();
    const since = israelMidnight(day);
    const [alerts, usageRows, employerRows, denials, admins] = await Promise.all([
      query(`SELECT id, kind, user_email, day, threshold, details, created_at FROM security_alerts
              WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 100`),
      query<{ actor: string }>(`SELECT DISTINCT actor FROM audit_log WHERE at >= $1 AND action = ANY($2)`,
        [since, [...BUDGET_ACTIONS.cvs, ...BUDGET_ACTIONS.people]]),
      // Employers who saw forwarded applicants today, by budget owner (user:<id>; their own budgets, no grants): an
      // employer who is also staff is logged by email on a Google session, with budget_owner = their account.
      query<{ actor: string }>(`SELECT DISTINCT COALESCE(details->>'budget_owner', actor) AS actor FROM audit_log WHERE at >= $1 AND action = ANY($2)`,
        [since, [...BUDGET_ACTIONS.employerCvs, ...BUDGET_ACTIONS.employerPeople]]),
      queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log WHERE at >= $1 AND action = 'access.denied'`, [since]),
      staffWithReviews(),
    ]);
    const usage = await Promise.all(usageRows.map(async ({ actor }) => ({
      actor, cvs: await dailyUsage(actor, 'cvs'), people: await dailyUsage(actor, 'people'),
    })));
    const employerUsage = await Promise.all(employerRows.map(async ({ actor }) => ({
      actor, cvs: await dailyUsage(actor, 'employerCvs'), people: await dailyUsage(actor, 'employerPeople'),
    })));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      day, limits: LIMITS, review: REVIEW,
      alerts, usage, employerUsage,
      deniedToday: denials?.n ?? 0,
      auditFailures: { count: auditFailures.count, last: auditFailures.last, lastAction: auditFailures.lastAction },
      staff: admins,
      reviewsDue: admins.filter((a) => a.state !== 'valid').length,
    } });
  } catch (e) { next(e); }
};

export const grant = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const budget = String(req.body?.budget ?? '') as Budget;
    // Only staff budgets can be topped up; an employer's daily limit is never raised.
    if (!email || !GRANTABLE_BUDGETS.includes(budget)) return bad(res, 'email and budget (cvs | people) are required');
    // Budgets belong to the roles that see candidates (coordinators, content managers and admins).
    const who = await queryOne(`SELECT 1 FROM users WHERE lower(email) = $1 AND role = ANY($2) AND deactivated_at IS NULL`, [email, [...VIEWER_ROLES]]);
    if (!who) return bad(res, 'not an active staff member', 404);
    const day = israelDay();
    const extra = LIMITS[budget].grant;
    const by = actorOf(req);
    await query(`INSERT INTO quota_grants (budget, user_email, day, extra, granted_by) VALUES ($1, $2, $3, $4, $5)`,
      [budget, email, day, extra, by]);
    await query(`UPDATE security_alerts SET handled_at = now(), handled_by = $1
                  WHERE handled_at IS NULL AND lower(user_email) = $2 AND day = $3 AND kind LIKE $4`,
      [by, email, day, `${budget}_%`]);
    await writeAudit(by, 'security.quota_granted', email, { budget, extra, day, self: by.toLowerCase() === email });
    res.json({ data: { usage: await dailyUsage(email, budget) } });
  } catch (e) { next(e); }
};

export const handleAlert = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return bad(res, 'bad alert id');
    const by = actorOf(req);
    const row = await queryOne<{ user_email: string; kind: string }>(
      `UPDATE security_alerts SET handled_at = now(), handled_by = $1 WHERE id = $2 AND handled_at IS NULL RETURNING user_email, kind`, [by, id]);
    if (!row) return bad(res, 'alert not found or already handled', 404);
    await writeAudit(by, 'security.alert_handled', row.user_email, { id, kind: row.kind, self: by.toLowerCase() === row.user_email.toLowerCase() });
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
};

export const confirmReview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId);
    if (!isObjectId(userId)) return bad(res, 'bad user id');
    const user = await queryOne<{ id: string; email: string; role: string }>(`SELECT id, email, role FROM users WHERE id = $1`, [userId]);
    if (!user || !REVIEWED_ROLES.includes(user.role)) return bad(res, 'not a staff member', 404);
    const last = await queryOne<{ valid_until: Date; role_at_review: string }>(
      `SELECT valid_until, role_at_review FROM access_reviews WHERE user_id = $1 ORDER BY reviewed_at DESC LIMIT 1`, [userId]);
    const current = last && last.role_at_review === user.role ? new Date(last.valid_until) : null;
    const validUntil = nextValidUntil(current);
    const by = actorOf(req);
    await query(`INSERT INTO access_reviews (user_id, reviewed_by, role_at_review, valid_until) VALUES ($1, $2, $3, $4)`,
      [userId, by, user.role, validUntil]);
    await writeAudit(by, 'security.access_reviewed', user.email, { role: user.role, valid_until: validUntil, self: by.toLowerCase() === user.email.toLowerCase() });
    res.json({ data: { validUntil } });
  } catch (e) { next(e); }
};

/** Removes staff access (admin or content manager → candidate role). Same lock-out rules as the staff screen. */
export const revokeAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId);
    if (!isObjectId(userId)) return bad(res, 'bad user id');
    if (userId === req.authUser?.id) return bad(res, 'you cannot remove your own access here', 409);
    const result = await changeStaffRole(req, userId, 'user', 'security.admin_revoked', { staffOnly: true });
    if (result.status !== 200) return bad(res, result.message, result.status);
    res.json({ data: { ok: true } });
  } catch (e) { next(e); }
};

/** The activity log, newest first, 100 at a time. `subject` (candidate id or email) answers "who saw X". */
export const auditSearch = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const subject = String(req.query.subject ?? '').trim().slice(0, 320);
    const actor = String(req.query.actor ?? '').trim().slice(0, 320);
    const action = String(req.query.action ?? '').trim().slice(0, 80);
    const before = Number(req.query.before) || 0;
    const where: string[] = [];
    const params: any[] = [];
    if (subject) {
      const ids = new Set<string>();
      if (isObjectId(subject)) ids.add(subject);
      if (subject.includes('@')) {
        for (const r of await query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [subject])) ids.add(r.id);
      }
      const ors: string[] = [];
      params.push(subject); ors.push(`left(target, 1000) = $${params.length}`);
      for (const id of ids) {
        params.push(id); ors.push(`left(target, 1000) = $${params.length}`);
        params.push(JSON.stringify({ ids: [id] })); ors.push(`details @> $${params.length}::jsonb`);
      }
      where.push(`(${ors.join(' OR ')})`);
    }
    if (actor) { params.push(actor.toLowerCase()); where.push(`lower(actor) = $${params.length}`); }
    // Prefix match; '_' is part of action names (cv_opened, role_changed), so escape it rather than drop it.
    if (action) { params.push(`${escapeLike(action)}%`); where.push(`action LIKE $${params.length}`); }
    if (before > 0) { params.push(before); where.push(`id < $${params.length}`); }
    const rows = await query(
      `SELECT id, at, actor, action, target, details FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT 100`, params);
    void writeAudit(actorOf(req), 'audit.searched', subject || null, { actor: actor || undefined, action: action || undefined, results: rows.length });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { entries: rows, next: rows.length === 100 ? (rows[rows.length - 1] as any).id : null } });
  } catch (e) { next(e); }
};

/** Groups of the per-person view (prefix match on the action). */
const PERSON_GROUPS: Record<string, string[]> = {
  signins: ['auth.'],
  applications: ['job.applied', 'guest.applied'],
  uploads: ['cv.', 'candidate.cv_unlinked', 'user.profile_updated'],
  views: ['candidates.shown', 'candidate.', 'employer.applicants_shown', 'employer.cv_opened', 'jobs.submission_viewed', 'jobs.edit_request_viewed'],
};

type PersonRow = { id: string; email: string; role: string; created_at: Date; deactivated_at: Date | null };

/**
 * GET /api/admin/audit/person?who=<user id | user:<id> | staff email>&group=&before=
 * Everything one account did: its own entries (as staff by email, as a candidate / employer by user:<id>; both, in
 * case the role changed) and the failed sign-in attempts on it (details.account). Plus its sign-in addresses and
 * devices. For a candidate or an employer the answer has the id and role only, never the email. Opening it is
 * recorded (strict) before anything is sent.
 */
export const personActivity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const who = String(req.query.who ?? '').trim().slice(0, 320);
    const group = String(req.query.group ?? '');
    const before = Number(req.query.before) || 0;
    const idText = who.startsWith('user:') ? who.slice(5) : who;
    const cols = `id, email, role, created_at, deactivated_at`;
    const user = isObjectId(idText)
      ? await queryOne<PersonRow>(`SELECT ${cols} FROM users WHERE id = $1`, [idText])
      : who.includes('@') ? await queryOne<PersonRow>(`SELECT ${cols} FROM users WHERE lower(email) = lower($1)`, [who]) : null;
    if (!user) return bad(res, 'account not found', 404);
    const ref = `user:${user.id}`;
    const actors = [ref, user.email.toLowerCase()];
    const account = JSON.stringify({ account: ref });
    const params: any[] = [actors, account];
    const where = [`(lower(actor) = ANY($1) OR details @> $2::jsonb)`];
    const prefixes = PERSON_GROUPS[group];
    if (prefixes) {
      params.push(prefixes.map((p) => `${escapeLike(p)}%`));
      where.push(`action LIKE ANY($${params.length})`);
    }
    if (before > 0) { params.push(before); where.push(`id < $${params.length}`); }
    const viewActions = [...BUDGET_ACTIONS.cvs, ...BUDGET_ACTIONS.people, ...BUDGET_ACTIONS.employerCvs, ...BUDGET_ACTIONS.employerPeople];
    const [rows, addresses, totals] = await Promise.all([
      query(`SELECT id, at, actor, action, target, details FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`, params),
      query<{ ip: string; device: string; n: number; first: Date; last: Date }>(
        `SELECT details->>'ip' AS ip, details->>'device' AS device, COUNT(*)::int AS n, min(at) AS first, max(at) AS last
           FROM audit_log WHERE lower(actor) = ANY($1) AND action = 'auth.login' AND details ? 'ip'
          GROUP BY 1, 2 ORDER BY max(at) DESC LIMIT 50`, [actors]),
      queryOne<{ signins: number; failures: number; applications: number; uploads: number; views: number }>(
        `SELECT COUNT(*) FILTER (WHERE action = 'auth.login')::int AS signins,
                COUNT(*) FILTER (WHERE details @> $2::jsonb AND action <> 'auth.login')::int AS failures,
                COUNT(*) FILTER (WHERE action = 'job.applied')::int AS applications,
                COUNT(*) FILTER (WHERE action = 'cv.attached')::int AS uploads,
                COUNT(*) FILTER (WHERE action = ANY($3))::int AS views
           FROM audit_log WHERE lower(actor) = ANY($1) OR details @> $2::jsonb`, [actors, account, viewActions]),
    ]);
    const staff = REVIEWED_ROLES.includes(user.role);
    // Strict: an account's addresses and activity are personal data. No record → nothing is sent (503).
    await writeAuditStrict(actorOf(req), 'audit.person_viewed', ref, { role: user.role, group: prefixes ? group : undefined, results: rows.length });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: {
      account: { id: user.id, ref, role: user.role, email: staff ? user.email : null, createdAt: user.created_at, deactivated: !!user.deactivated_at },
      totals, addresses, entries: rows, next: rows.length === 100 ? (rows[rows.length - 1] as any).id : null,
    } });
  } catch (e) {
    if (e instanceof AuditWriteError) return res.status(503).json({ message: 'activity log unavailable', code: 'audit_unavailable' });
    next(e);
  }
};
