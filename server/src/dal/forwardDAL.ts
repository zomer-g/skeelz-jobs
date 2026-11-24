// Applications forwarded to employers (docs/employers.md "Applicants"; table employer_forwards in config/db.ts).
//
// Staff (content managers and admins) forward ONE application at a time to the employer who owns the job
// (employer_jobs). An employer sees a forward only when ALL of these hold, checked in SQL on every request
// (VISIBLE below), with the employer's id from the session:
//   - the forward is theirs and live (not cancelled), and the job is still theirs in employer_jobs;
//   - the job was not imported from the existing site (those have no owner here);
//   - the job is active, or stopped being active less than EMPLOYER_ACCESS_DAYS ago (job_inactive_since);
//   - the application's candidate still exists (a registered candidate whose account is deactivated is hidden).
// What leaves for the employer: the candidate's name, the forward date, the job, whether there is a CV (and the
// CV itself through cvHandover). Never an email, phone, city, candidate id or application id.
// Nothing here deletes anything (the table refuses DELETE; a cancel sets cancelled_at, only before first_seen_at).
import { pool, query, queryOne } from '../config/db.js';
import { EMPLOYER_ACCESS_DAYS, employerWindowOpen, forwardCancelRefusal } from '../security/pure.js';
import { isObjectId, newObjectId } from '../utils/ids.js';

export type ForwardKind = 'application' | 'guest';
export const FORWARD_KINDS: readonly ForwardKind[] = ['application', 'guest'];

/** Rows of `f` (employer_forwards) an employer ($1) may see now. Joins: ej, j, jis, a/u (registered), g (guest). */
const VISIBLE_FROM = `
  FROM employer_forwards f
  JOIN employer_jobs ej ON ej.job_id = f.job_id AND ej.user_id = f.employer_user_id
  JOIN jobs j ON j.id = f.job_id
  LEFT JOIN job_inactive_since jis ON jis.job_id = j.id
  LEFT JOIN job_applications a ON f.kind = 'application' AND a.id = f.application_id AND a.user_id = f.candidate_id
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN guest_applications g ON f.kind = 'guest' AND g.id = f.application_id
 WHERE f.employer_user_id = $1 AND f.cancelled_at IS NULL AND NOT j.imported_from_live
   AND ((j.status = 'Active' AND j.deleted_at IS NULL)
        OR (jis.since IS NOT NULL AND jis.since > now() - make_interval(days => ${EMPLOYER_ACCESS_DAYS})))
   AND ((f.kind = 'application' AND u.id IS NOT NULL AND u.deactivated_at IS NULL) OR (f.kind = 'guest' AND g.id IS NOT NULL))`;

export type VisibleForward = {
  forwardId: string; kind: ForwardKind; candidateId: string; jobId: string; jobNumber: number; jobTitle: string;
  jobActive: boolean; inactiveSince: Date | null; name: string; forwardedAt: Date; hasCv: boolean; firstSeenAt: Date | null;
};

const toVisible = (r: any): VisibleForward => ({
  forwardId: r.id, kind: r.kind, candidateId: r.candidate_id, jobId: r.job_id, jobNumber: r.job_number, jobTitle: r.title,
  jobActive: r.status === 'Active' && !r.deleted_at, inactiveSince: r.since ?? null, name: String(r.name ?? '').trim(),
  forwardedAt: r.forwarded_at, hasCv: !!r.cv_key, firstSeenAt: r.first_seen_at ?? null,
});

/** The forwards an employer may see now, newest first; optionally for one of their jobs. */
export const visibleForwards = async (employerId: string, jobId?: string): Promise<VisibleForward[]> => {
  const params: any[] = [employerId];
  let extra = '';
  if (jobId) { params.push(jobId); extra = ` AND f.job_id = $2`; }
  const rows = await query(
    `SELECT f.id, f.kind, f.candidate_id, f.job_id, f.forwarded_at, f.first_seen_at, j.job_id AS job_number, j.title, j.status,
            j.deleted_at, jis.since,
            CASE WHEN f.kind = 'application' THEN concat_ws(' ', u.first_name, u.last_name) ELSE g.full_name END AS name,
            CASE WHEN f.kind = 'application' THEN COALESCE(a.cv_file_url, '') ELSE COALESCE(g.cv_key, '') END AS cv_key
     ${VISIBLE_FROM}${extra}
     ORDER BY f.forwarded_at DESC, f.id DESC LIMIT 1000`, params);
  return rows.map(toVisible);
};

/** Marks forwards as shown to the employer (once; never unset). Returns the ids that are still live — a forward
 *  cancelled in the meantime is not among them and must not be sent. */
export const markSeen = async (employerId: string, ids: string[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  await query(
    `UPDATE employer_forwards SET first_seen_at = now()
      WHERE id = ANY($2::text[]) AND employer_user_id = $1 AND first_seen_at IS NULL AND cancelled_at IS NULL`, [employerId, ids]);
  const live = await query<{ id: string }>(
    `SELECT id FROM employer_forwards WHERE id = ANY($2::text[]) AND employer_user_id = $1 AND cancelled_at IS NULL AND first_seen_at IS NOT NULL`,
    [employerId, ids]);
  return new Set(live.map((r) => r.id));
};

/** One visible forward with its CV key. null when not visible / cancelled. NOT marked as seen here: the caller marks
 *  it (markSeen) only after the strict log entry was written, so a refused log (503, nothing sent) leaves the forward
 *  unseen and still cancellable. */
export const openForwardCv = async (employerId: string, forwardId: string): Promise<{ candidateId: string; kind: ForwardKind; jobId: string; cvKey: string } | null> => {
  if (!isObjectId(forwardId)) return null;
  const r = await queryOne(
    `SELECT f.id, f.kind, f.candidate_id, f.job_id,
            CASE WHEN f.kind = 'application' THEN COALESCE(a.cv_file_url, '') ELSE COALESCE(g.cv_key, '') END AS cv_key
     ${VISIBLE_FROM} AND f.id = $2`, [employerId, forwardId]);
  if (!r) return null;
  return { candidateId: r.candidate_id, kind: r.kind, jobId: r.job_id, cvKey: r.cv_key || '' };
};

/** Whether the job is the employer's and could carry applicants (not imported). Ownership from the DB only. */
export const ownsForwardableJob = async (employerId: string, jobId: string): Promise<boolean> => {
  if (!isObjectId(jobId)) return false;
  return !!(await queryOne(
    `SELECT 1 FROM employer_jobs ej JOIN jobs j ON j.id = ej.job_id WHERE ej.user_id = $1 AND ej.job_id = $2 AND NOT j.imported_from_live`,
    [employerId, jobId]));
};

// ---- staff ---------------------------------------------------------------------------------

export type ForwardState = 'pending' | 'forwarded' | 'seen';
export type StaffForwardRow = {
  kind: ForwardKind; applicationId: string; candidateId: string; name: string; appliedAt: Date; hasCv: boolean;
  jobId: string; jobNumber: number; jobTitle: string; jobActive: boolean; accessOpen: boolean;
  employer: { id: string; companyName: string; name: string; active: boolean };
  state: ForwardState; forward: { id: string; at: Date; seenAt: Date | null } | null; forwardable: boolean;
};

/** Applications (registered + quick) to jobs an employer owns (not imported), with the forward state. */
const STAFF_FROM = `
  FROM (
    SELECT 'application'::text AS kind, a.id AS application_id, a.user_id AS candidate_id, a.job_id, a.created_at AS applied_at,
           concat_ws(' ', u.first_name, u.last_name) AS name, (COALESCE(a.cv_file_url, '') <> '') AS has_cv
      FROM job_applications a JOIN users u ON u.id = a.user_id AND u.deactivated_at IS NULL
    UNION ALL
    SELECT 'guest'::text, g.id, g.id, g.job_id, g.created_at, g.full_name, (g.cv_key <> '') FROM guest_applications g
  ) x
  JOIN employer_jobs ej ON ej.job_id = x.job_id
  JOIN jobs j ON j.id = x.job_id AND NOT j.imported_from_live
  JOIN users eu ON eu.id = ej.user_id AND 'employer' = ANY(eu.roles)
  LEFT JOIN employer_profiles ep ON ep.user_id = eu.id
  LEFT JOIN job_inactive_since jis ON jis.job_id = j.id
  LEFT JOIN employer_forwards f ON f.kind = x.kind AND f.application_id = x.application_id AND f.cancelled_at IS NULL`;
const WINDOW_OPEN = `((j.status = 'Active' AND j.deleted_at IS NULL)
  OR (jis.since IS NOT NULL AND jis.since > now() - make_interval(days => ${EMPLOYER_ACCESS_DAYS})))`;

export const listForStaff = async (opts: { state: 'pending' | 'forwarded' | 'all'; page: number; limit: number; jobId?: string }) => {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.state === 'pending') where.push(`f.id IS NULL AND eu.deactivated_at IS NULL AND ${WINDOW_OPEN}`);
  if (opts.state === 'forwarded') where.push(`f.id IS NOT NULL`);
  if (opts.jobId) { params.push(opts.jobId); where.push(`x.job_id = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    query(
      `SELECT x.*, j.job_id AS job_number, j.title, j.status, j.deleted_at, jis.since, eu.id AS employer_id,
              eu.first_name AS e_first, eu.last_name AS e_last, eu.deactivated_at AS e_deactivated, ep.company_name,
              f.id AS forward_id, f.forwarded_at, f.first_seen_at, ${WINDOW_OPEN} AS window_open
       ${STAFF_FROM} ${w}
       ORDER BY ep.company_name NULLS LAST, eu.id, j.job_id DESC, x.applied_at DESC, x.application_id
       LIMIT ${opts.limit} OFFSET ${(opts.page - 1) * opts.limit}`, params),
    queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n ${STAFF_FROM} ${w}`, params),
  ]);
  return {
    total: total?.n ?? 0,
    rows: rows.map((r): StaffForwardRow => {
      const state: ForwardState = !r.forward_id ? 'pending' : r.first_seen_at ? 'seen' : 'forwarded';
      return {
        kind: r.kind, applicationId: r.application_id, candidateId: r.candidate_id, name: String(r.name ?? '').trim(),
        appliedAt: r.applied_at, hasCv: !!r.has_cv, jobId: r.job_id, jobNumber: r.job_number, jobTitle: r.title,
        jobActive: r.status === 'Active' && !r.deleted_at, accessOpen: !!r.window_open,
        employer: { id: r.employer_id, companyName: r.company_name ?? '', name: `${r.e_first ?? ''} ${r.e_last ?? ''}`.trim(), active: !r.e_deactivated },
        state, forward: r.forward_id ? { id: r.forward_id, at: r.forwarded_at, seenAt: r.first_seen_at ?? null } : null,
        forwardable: !r.forward_id && !r.e_deactivated && !!r.window_open,
      };
    }),
  };
};

/** Pending count (applications that could be forwarded now): no names, for the staff badge. */
export const countPendingForStaff = async (): Promise<number> =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n ${STAFF_FROM} WHERE f.id IS NULL AND eu.deactivated_at IS NULL AND ${WINDOW_OPEN}`))?.n ?? 0;

/** For the guest-applications list: which rows belong to an employer's job, and their live forward. */
export const forwardInfo = async (kind: ForwardKind, applicationIds: string[]) => {
  const out = new Map<string, { employerJob: boolean; state: ForwardState; forwardId: string | null; forwardable: boolean }>();
  if (!applicationIds.length) return out;
  const src = kind === 'guest'
    ? `SELECT g.id AS application_id, g.job_id FROM guest_applications g WHERE g.id = ANY($1::text[])`
    : `SELECT a.id AS application_id, a.job_id FROM job_applications a WHERE a.id = ANY($1::text[])`;
  const rows = await query(
    `SELECT x.application_id, ej.user_id AS employer_id, eu.deactivated_at AS e_deactivated, f.id AS forward_id, f.first_seen_at,
            ${WINDOW_OPEN} AS window_open
       FROM (${src}) x
       JOIN employer_jobs ej ON ej.job_id = x.job_id
       JOIN jobs j ON j.id = x.job_id AND NOT j.imported_from_live
       JOIN users eu ON eu.id = ej.user_id AND 'employer' = ANY(eu.roles)
       LEFT JOIN job_inactive_since jis ON jis.job_id = j.id
       LEFT JOIN employer_forwards f ON f.kind = $2 AND f.application_id = x.application_id AND f.cancelled_at IS NULL`,
    [applicationIds, kind]);
  for (const r of rows) {
    out.set(r.application_id, {
      employerJob: true, forwardId: r.forward_id ?? null,
      state: !r.forward_id ? 'pending' : r.first_seen_at ? 'seen' : 'forwarded',
      forwardable: !r.forward_id && !r.e_deactivated && !!r.window_open,
    });
  }
  return out;
};

export type ForwardRefusal = 'application_not_found' | 'no_employer' | 'employer_inactive' | 'window_closed' | 'already_forwarded';
export type ForwardRecord = { id: string; kind: ForwardKind; applicationId: string; candidateId: string; jobId: string; employerId: string };

/** Forwards one application to the job's employer. Ownership, job state and the window are read from the DB. */
export const createForward = async (kind: ForwardKind, applicationId: string, by: string):
  Promise<{ ok: true; forward: ForwardRecord } | { ok: false; code: ForwardRefusal }> => {
  if (!isObjectId(applicationId)) return { ok: false, code: 'application_not_found' };
  const app = kind === 'guest'
    ? await queryOne<{ candidate_id: string; job_id: string }>(`SELECT id AS candidate_id, job_id FROM guest_applications WHERE id = $1`, [applicationId])
    : await queryOne<{ candidate_id: string; job_id: string }>(
      `SELECT a.user_id AS candidate_id, a.job_id FROM job_applications a JOIN users u ON u.id = a.user_id AND u.deactivated_at IS NULL WHERE a.id = $1`,
      [applicationId]);
  if (!app) return { ok: false, code: 'application_not_found' };
  const job = await queryOne<{ employer_id: string; e_deactivated: Date | null; status: string; deleted_at: Date | null; since: Date | null }>(
    `SELECT ej.user_id AS employer_id, eu.deactivated_at AS e_deactivated, j.status, j.deleted_at, jis.since
       FROM employer_jobs ej JOIN jobs j ON j.id = ej.job_id AND NOT j.imported_from_live
       JOIN users eu ON eu.id = ej.user_id AND 'employer' = ANY(eu.roles)
       LEFT JOIN job_inactive_since jis ON jis.job_id = j.id
      WHERE ej.job_id = $1`, [app.job_id]);
  if (!job) return { ok: false, code: 'no_employer' };
  if (job.e_deactivated) return { ok: false, code: 'employer_inactive' };
  if (!employerWindowOpen({ status: job.status, deletedAt: job.deleted_at }, job.since)) return { ok: false, code: 'window_closed' };
  const id = newObjectId();
  const row = await queryOne(
    `INSERT INTO employer_forwards (id, kind, application_id, candidate_id, job_id, employer_user_id, forwarded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (kind, application_id) WHERE cancelled_at IS NULL DO NOTHING RETURNING id`,
    [id, kind, applicationId, app.candidate_id, app.job_id, job.employer_id, by]);
  if (!row) return { ok: false, code: 'already_forwarded' };
  return { ok: true, forward: { id, kind, applicationId, candidateId: app.candidate_id, jobId: app.job_id, employerId: job.employer_id } };
};

/** Cancels a forward the employer has not been shown yet (atomic: a forward the employer sees at the same moment
 *  stays). After that it can't be undone. */
export const cancelForward = async (id: string, by: string):
  Promise<{ ok: true; forward: ForwardRecord } | { ok: false; code: 'forward_not_found' | 'forward_cancelled' | 'forward_seen' }> => {
  if (!isObjectId(id)) return { ok: false, code: 'forward_not_found' };
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE employer_forwards SET cancelled_at = now(), cancelled_by = $2
        WHERE id = $1 AND cancelled_at IS NULL AND first_seen_at IS NULL
        RETURNING id, kind, application_id, candidate_id, job_id, employer_user_id`, [id, by]);
    if (r.rows[0]) {
      const f = r.rows[0];
      return { ok: true, forward: { id: f.id, kind: f.kind, applicationId: f.application_id, candidateId: f.candidate_id, jobId: f.job_id, employerId: f.employer_user_id } };
    }
    const cur = (await client.query(`SELECT cancelled_at, first_seen_at FROM employer_forwards WHERE id = $1`, [id])).rows[0];
    const code = forwardCancelRefusal(cur ? { cancelledAt: cur.cancelled_at, firstSeenAt: cur.first_seen_at } : null) ?? 'forward_not_found';
    return { ok: false, code };
  } finally {
    client.release();
  }
};

/** Withdraws a just-made forward whose log entry could not be written (no record → no hand-over). */
export const undoForward = (id: string) =>
  query(`UPDATE employer_forwards SET cancelled_at = now(), cancelled_by = 'system:audit_failed' WHERE id = $1 AND first_seen_at IS NULL AND cancelled_at IS NULL`, [id]);

export const forwardById = async (id: string) =>
  isObjectId(id) ? queryOne(`SELECT id, kind, application_id, candidate_id, job_id, employer_user_id, first_seen_at, cancelled_at FROM employer_forwards WHERE id = $1`, [id]) : null;
