/* ============================================================================
 *  Salesforce push through the internal API. Idempotent: each record is found in
 *  Salesforce by its id field (or by the Salesforce Id stored last time) and
 *  updated, or created if it isn't there. One row per record in salesforce_sync:
 *  last pushed at, Salesforce Id, last error CODE (never a response body).
 *
 *  Off unless ENABLE_SALESFORCE=true: the routes answer 409 before anything
 *  here runs, and the service functions refuse again without calling out.
 *  Candidates' data leaves to Salesforce, so the push is written to the
 *  activity log (strict, salesforce.pushed, with the candidate ids) BEFORE the
 *  first outbound call.
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import * as jobDAL from '../dal/jobDAL.js';
import * as userDAL from '../dal/userDAL.js';
import * as locationService from '../services/locationService.js';
import * as salesforceService from '../services/salesforceService.js';
import { writeAuditStrict } from '../security/audit.js';
import { capIds } from '../security/pure.js';
import { isObjectId } from '../utils/ids.js';
import { salesforceErrorCode } from './pure.js';

export const SYNC_KINDS = ['job', 'application', 'candidate'] as const;
export type SyncKind = typeof SYNC_KINDS[number];
export const isSyncKind = (v: unknown): v is SyncKind => typeof v === 'string' && (SYNC_KINDS as readonly string[]).includes(v);

export const salesforceEnabled = () => appConfig.salesforce.enableSalesforce;

export type PushResult = { kind: SyncKind; id: string; ok: boolean; sfId?: string; created?: boolean; error?: string; note?: string };

class PushError extends Error { constructor(public code: string) { super(code); } }

const syncRow = (kind: SyncKind, id: string) =>
  queryOne<{ sf_id: string | null }>(`SELECT sf_id FROM salesforce_sync WHERE kind = $1 AND record_id = $2`, [kind, id]);

const recordOk = (kind: SyncKind, id: string, sfId: string, note: string | null) => query(
  `INSERT INTO salesforce_sync (kind, record_id, sf_id, last_pushed_at, last_attempt_at, last_error_code, attempts)
   VALUES ($1, $2, $3, now(), now(), $4, 1)
   ON CONFLICT (kind, record_id) DO UPDATE SET sf_id = EXCLUDED.sf_id, last_pushed_at = now(), last_attempt_at = now(),
     last_error_code = EXCLUDED.last_error_code, attempts = salesforce_sync.attempts + 1`, [kind, id, sfId, note]);

const recordError = (kind: SyncKind, id: string, code: string) => query(
  `INSERT INTO salesforce_sync (kind, record_id, last_attempt_at, last_error_code, attempts) VALUES ($1, $2, now(), $3, 1)
   ON CONFLICT (kind, record_id) DO UPDATE SET last_attempt_at = now(), last_error_code = EXCLUDED.last_error_code,
     attempts = salesforce_sync.attempts + 1`, [kind, id, code.slice(0, 80)]);

const pushJob = async (id: string) => {
  const job = await jobDAL.findJobByJobId(id, { withComments: true });
  if (!job) throw new PushError('not_found');
  let loc;
  try { loc = await locationService.getLocationByCitySymbol(job.citySymbol); } catch { throw new PushError('location_not_found'); }
  return salesforceService.upsertJobCase(job, loc, (await syncRow('job', id))?.sf_id ?? undefined);
};

const pushCandidate = async (id: string) => {
  const user: any = await userDAL.findUserById(id);
  if (!user || user.role !== 'user') throw new PushError('not_found');
  delete user.password;
  return salesforceService.upsertContact(user, (await syncRow('candidate', id))?.sf_id ?? undefined);
};

const pushApplication = async (id: string): Promise<{ id: string; created: boolean; note?: string }> => {
  const app = await queryOne(`SELECT id, user_id, job_id, cv_file_url, cv_scope, created_at FROM job_applications WHERE id = $1`, [id]);
  if (!app) throw new PushError('not_found');
  // The Case points at the candidate's Contact: make sure it is there first.
  if (!(await syncRow('candidate', app.user_id))?.sf_id) {
    const c = await pushOneRecorded('candidate', app.user_id);
    if (!c.ok) throw new PushError(`candidate_${c.error}`);
  }
  const ja = { _id: app.id, userId: app.user_id, jobId: app.job_id, cvFileUrl: app.cv_file_url || '', cvScope: app.cv_scope || '' };
  const r = await salesforceService.ensureApplicationCase(ja, (await syncRow('application', id))?.sf_id ?? undefined);
  if (r.created && ja.cvFileUrl) {
    try { await salesforceService.attachCvToApplicationCase(ja.cvFileUrl, r.id, ja._id); }
    catch (e) { return { ...r, note: `cv_not_attached:${salesforceErrorCode(e)}` }; }
  }
  return r;
};

/** One record: push and record the outcome. No log entry here (callers write it first). */
const pushOneRecorded = async (kind: SyncKind, id: string): Promise<PushResult> => {
  if (!salesforceEnabled()) return { kind, id, ok: false, error: 'salesforce_disabled' };
  try {
    const r: { id: string; created: boolean; note?: string } =
      kind === 'job' ? await pushJob(id) : kind === 'candidate' ? await pushCandidate(id) : await pushApplication(id);
    await recordOk(kind, id, r.id, r.note ?? null);
    return { kind, id, ok: true, sfId: r.id, created: r.created, ...(r.note ? { note: r.note } : {}) };
  } catch (e) {
    const code = e instanceof PushError ? e.code : salesforceErrorCode(e);
    if (code !== 'not_found') await recordError(kind, id, code).catch(() => undefined);
    return { kind, id, ok: false, error: code };
  }
};

/** Candidate ids a push hands to Salesforce (for the log: "who received X"). */
const peopleOf = async (kind: SyncKind, ids: string[]): Promise<string[]> => {
  if (kind === 'candidate') return ids;
  if (kind === 'application' && ids.length) {
    const rows = await query<{ user_id: string }>(`SELECT DISTINCT user_id FROM job_applications WHERE id = ANY($1::text[])`, [ids]);
    return rows.map((r) => r.user_id);
  }
  return [];
};

/** Pushes these records (same kind). Strict log entry first; stops early if Salesforce refuses the login. */
export const pushRecords = async (actor: string, kind: SyncKind, ids: string[], place: string): Promise<PushResult[]> => {
  const valid = [...new Set(ids)].filter(isObjectId);
  if (!valid.length) return [];
  const people = await peopleOf(kind, valid);
  await writeAuditStrict(actor, 'salesforce.pushed', place, {
    kind, records: valid.slice(0, 1000), ...capIds(people), count: valid.length,
  });
  const out: PushResult[] = [];
  for (const id of valid) {
    const r = await pushOneRecorded(kind, id);
    out.push(r);
    if (r.error === 'auth') break;
  }
  return out;
};

/** Records never pushed, or changed since the last push (applications: never pushed). */
export const pendingIds = async (kind: SyncKind, limit: number): Promise<string[]> => {
  const sql = kind === 'job'
    ? `SELECT j.id FROM jobs j LEFT JOIN salesforce_sync s ON s.kind = 'job' AND s.record_id = j.id
        WHERE s.last_pushed_at IS NULL OR j.updated_at > s.last_pushed_at ORDER BY j.updated_at LIMIT $1`
    : kind === 'candidate'
      ? `SELECT u.id FROM users u LEFT JOIN salesforce_sync s ON s.kind = 'candidate' AND s.record_id = u.id
          WHERE u.role = 'user' AND (s.last_pushed_at IS NULL OR u.updated_at > s.last_pushed_at) ORDER BY u.updated_at LIMIT $1`
      : `SELECT a.id FROM job_applications a LEFT JOIN salesforce_sync s ON s.kind = 'application' AND s.record_id = a.id
          WHERE s.last_pushed_at IS NULL ORDER BY a.created_at LIMIT $1`;
  return (await query<{ id: string }>(sql, [limit])).map((r) => r.id);
};

export const syncState = async (f: { kind?: SyncKind; status?: 'error' | 'synced'; limit: number; offset: number }) => {
  const params: any[] = [];
  const where: string[] = [];
  if (f.kind) { params.push(f.kind); where.push(`kind = $${params.length}`); }
  if (f.status === 'error') where.push(`last_error_code IS NOT NULL`);
  if (f.status === 'synced') where.push(`last_pushed_at IS NOT NULL AND last_error_code IS NULL`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await query(
    `SELECT kind, record_id AS "recordId", sf_id AS "sfId", last_pushed_at AS "lastPushedAt", last_attempt_at AS "lastAttemptAt",
            last_error_code AS "lastErrorCode", attempts FROM salesforce_sync ${w}
      ORDER BY last_attempt_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params);
  const pending = Object.fromEntries(await Promise.all(SYNC_KINDS.map(async (k) => [k, (await pendingIds(k, 10000)).length])));
  return { rows, pending };
};
