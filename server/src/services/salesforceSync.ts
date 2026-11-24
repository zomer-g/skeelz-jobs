import { isCandidate } from '../models/enums.js';
/* ============================================================================
 *  Salesforce sync: a queue in salesforce_sync and a background worker.
 *
 *  - A change on the site (sign-up, profile, application, quick application,
 *    job created/changed here, employer details) only QUEUES the record
 *    (queueSalesforce). The request never waits for Salesforce and never fails
 *    because of it.
 *  - The worker (startSalesforceWorker: right after a change, and every minute)
 *    sends what is due. Every push is idempotent (salesforceService.ts), so a
 *    retry never makes a second Contact or Case, and a CV file is sent once per
 *    record (synced_cv_key).
 *  - A failure is stored as a CODE (never a body) and retried with growing
 *    waits (salesforceSyncPure.RETRY_DELAYS_S); a permanent one (HTTP 400, a
 *    record that must not be pushed) stops at once. Admins see the state and can
 *    retry from the security screen (controllers/salesforceAdminController.ts).
 *  - People's details leave to Salesforce only after a STRICT activity-log
 *    entry (salesforce.pushed, with the people's ids) for that batch.
 *  - Off (ENABLE_SALESFORCE not 'true', or settings invalid, or the sandbox):
 *    nothing is queued and nothing is sent.
 *  - Jobs imported from the existing site are never queued nor pushed.
 *  - No backlog: what happened while it was off is never sent afterwards (owner's rule, 11.2026).
 * ========================================================================== */
import { userValues } from './customFieldsService.js';
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import * as jobDAL from '../dal/jobDAL.js';
import * as userDAL from '../dal/userDAL.js';
import * as employerDAL from '../dal/employerDAL.js';
import * as locationService from './locationService.js';
import * as sf from './salesforceService.js';
import { writeAuditStrict } from '../security/audit.js';
import { capIds, safeErrorText } from '../security/pure.js';
import { isObjectId } from '../utils/ids.js';
import { isAuthErrorCode, salesforceErrorCode } from '../internalApi/pure.js';
import { PEOPLE_KINDS, SYNC_KINDS, SyncKind, nextRetryDelay, syncRowState } from './salesforceSyncPure.js';

export { SYNC_KINDS, isSyncKind } from './salesforceSyncPure.js';
export type { SyncKind } from './salesforceSyncPure.js';

export const salesforceEnabled = () => appConfig.salesforce.enableSalesforce;
export const SYSTEM_ACTOR = 'system:salesforce-sync';

export type PushResult = { kind: SyncKind; id: string; ok: boolean; sfId?: string; created?: boolean; error?: string };

/** Our own failure with a code (and, when part of the work was done, the Salesforce ids made so far). */
class PushError extends Error {
  constructor(public code: string, public sfId?: string, public contactId?: string, public accountId?: string) { super(code); }
}

type Row = {
  sf_id: string | null; sf_contact_id: string | null; sf_account_id: string | null; synced_cv_key: string | null; fail_streak: number; queued: string | null;
  sf_legacy_cid: string | null; sf_match: string | null;
};
const rowOf = (kind: SyncKind, id: string) => queryOne<Row>(
  `SELECT sf_id, sf_contact_id, sf_account_id, synced_cv_key, fail_streak, queued_at::text AS queued, sf_legacy_cid, sf_match
     FROM salesforce_sync WHERE kind = $1 AND record_id = $2`,
  [kind, id]);

/** legacyCid / match: a candidate's Contact adopted by email (salesforceService.upsertContact); set on every candidate push. */
type Done = { id: string; created: boolean; contactId?: string; accountId?: string; cvKey?: string; legacyCid?: string | null; match?: string | null };

// ---- outcome ----
/** Success: state stored; the queue entry is cleared unless the record changed again while it was being sent. */
const recordOk = (kind: SyncKind, id: string, before: Row | null, r: Done) => query(
  `INSERT INTO salesforce_sync (kind, record_id, sf_id, sf_contact_id, synced_cv_key, sf_account_id, last_pushed_at, last_attempt_at, last_error_code, attempts, fail_streak,
                                sf_legacy_cid, sf_match)
   VALUES ($1, $2, $3, $4, $5, $7, now(), now(), NULL, 1, 0, $8, $9)
   ON CONFLICT (kind, record_id) DO UPDATE SET sf_id = EXCLUDED.sf_id, last_pushed_at = now(), last_attempt_at = now(),
     sf_legacy_cid = CASE WHEN $10::boolean THEN EXCLUDED.sf_legacy_cid ELSE salesforce_sync.sf_legacy_cid END,
     sf_match = CASE WHEN $10::boolean THEN COALESCE(EXCLUDED.sf_match, salesforce_sync.sf_match) ELSE salesforce_sync.sf_match END,
     sf_contact_id = COALESCE(EXCLUDED.sf_contact_id, salesforce_sync.sf_contact_id),
     sf_account_id = COALESCE(EXCLUDED.sf_account_id, salesforce_sync.sf_account_id),
     synced_cv_key = COALESCE(EXCLUDED.synced_cv_key, salesforce_sync.synced_cv_key),
     last_error_code = NULL, attempts = salesforce_sync.attempts + 1, fail_streak = 0,
     queued_at = CASE WHEN salesforce_sync.queued_at::text IS DISTINCT FROM $6 THEN salesforce_sync.queued_at END,
     next_attempt_at = CASE WHEN salesforce_sync.queued_at::text IS DISTINCT FROM $6 THEN now() END`,
  [kind, id, r.id, r.contactId ?? null, r.cvKey ?? null, before?.queued ?? null, r.accountId ?? null,
   r.legacyCid ?? null, r.match ?? null, kind === 'candidate' && 'legacyCid' in r]);

/** Failure: the code, and the next try (or none: it waits for an admin's retry). A missing record is not inserted. */
const recordError = async (kind: SyncKind, id: string, before: Row | null, code: string, partial?: { sfId?: string; contactId?: string; accountId?: string }) => {
  const streak = (before?.fail_streak ?? 0) + 1;
  const delay = nextRetryDelay(code, streak);
  const params = [kind, id, code.slice(0, 80), delay, partial?.sfId ?? null, partial?.contactId ?? null, partial?.accountId ?? null];
  const set = `last_attempt_at = now(), last_error_code = $3, attempts = salesforce_sync.attempts + 1, fail_streak = salesforce_sync.fail_streak + 1,
     sf_id = COALESCE($5, salesforce_sync.sf_id), sf_contact_id = COALESCE($6, salesforce_sync.sf_contact_id),
     sf_account_id = COALESCE($7, salesforce_sync.sf_account_id),
     queued_at = CASE WHEN $4::int IS NULL THEN NULL ELSE COALESCE(salesforce_sync.queued_at, now()) END,
     next_attempt_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END`;
  if (code === 'not_found') {
    await query(`UPDATE salesforce_sync SET ${set} WHERE kind = $1 AND record_id = $2`, params);
    return;
  }
  await query(
    `INSERT INTO salesforce_sync (kind, record_id, sf_id, sf_contact_id, sf_account_id, last_attempt_at, last_error_code, attempts, fail_streak, queued_at, next_attempt_at)
     VALUES ($1, $2, $5, $6, $7, now(), $3, 1, 1, CASE WHEN $4::int IS NULL THEN NULL ELSE now() END,
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(secs => $4::int) END)
     ON CONFLICT (kind, record_id) DO UPDATE SET ${set}`, params);
};

const codeOf = (e: unknown) => (e instanceof PushError ? e.code : salesforceErrorCode(e));

/** Uploads the CV and links it; a failure becomes a PushError that keeps the ids already made. */
const sendCv = async (key: string, linkTo: string[], marker: string, sfId: string, contactId?: string) => {
  try { await sf.attachCv(key, linkTo, marker); }
  catch (e) { throw new PushError(`cv_${salesforceErrorCode(e)}`, sfId, contactId); }
};

// ---- one record of each kind ----
const pushJob = async (id: string, row: Row | null): Promise<Done> => {
  const job = await jobDAL.findJobByJobId(id, { withComments: true });
  if (!job) throw new PushError('not_found');
  // A job imported from the existing site already has its Case there: never pushed from here.
  // A job imported from the existing site, or one of its jobs it still manages (mirror): its Case is there, never pushed.
  if ((job as any).importedFromLive) throw new PushError('imported_read_only');
  const loc = await locationService.getLocationByCitySymbol(job.citySymbol).catch(() => null);
  // A job an employer account posted points at that employer's Contact, once it is in Salesforce.
  const employer = await queryOne<{ sf_id: string | null }>(
    `SELECT s.sf_id FROM employer_jobs e JOIN salesforce_sync s ON s.kind = 'employer' AND s.record_id = e.user_id WHERE e.job_id = $1`, [id]);
  return sf.upsertJobCase(job, loc, row?.sf_id ?? undefined, employer?.sf_id ?? undefined);
};

const pushCandidate = async (id: string, row: Row | null): Promise<Done> => {
  const user: any = await userDAL.findUserById(id);
  if (!user || !isCandidate(user)) throw new PushError('not_found'); // the candidate role, whatever else they hold (M1)
  if (user.legacyState === 'mirror') throw new PushError('mirror_read_only');
  delete user.password;
  user.idNumber = await userDAL.findIdNumber(id); // sent only when the org has the field (salesforceUtils.ID_NUMBER_FIELD)
  // Answers to added sign-up questions: sent only for fields an admin linked and the org has (customFieldsForSalesforce).
  user.customFields = await userValues(id);
  // A Contact of the existing site with this candidate's (verified) email is adopted, not duplicated; those this site
  // made itself (another record's) are never adopted.
  // A candidate of the existing site (copied by the candidates mirror, sync match 'mirror'): their own Contact, in full.
  const r = await sf.upsertContact(user, { id: row?.sf_id ?? undefined, legacyCid: row?.sf_legacy_cid ?? null, full: row?.sf_match === 'mirror' }, contactsMadeHere);
  if (row?.sf_match === 'mirror') (r as any).match = 'mirror';
  // The profile CV goes on the Contact, once per file.
  const key = user.cvFileUrl ? String(user.cvFileUrl) : '';
  if (key && key !== row?.synced_cv_key) {
    await sendCv(key, [r.id], `userId:${id}`, r.id);
    return { ...r, cvKey: key };
  }
  return r;
};

/** Which of these Contacts this site made (a candidate's, an employer's or a quick applicant's), not adopted ones. */
const contactsMadeHere = async (ids: string[]): Promise<Set<string>> => {
  if (!ids.length) return new Set();
  const rows = await query<{ id: string }>(
    `SELECT sf_id AS id FROM salesforce_sync WHERE sf_id = ANY($1::text[]) AND kind IN ('candidate', 'employer') AND sf_legacy_cid IS NULL
     UNION SELECT sf_contact_id FROM salesforce_sync WHERE sf_contact_id = ANY($1::text[]) AND kind = 'guest_application'`, [ids]);
  return new Set(rows.map((r) => String(r.id)));
};

const pushApplication = async (id: string, row: Row | null): Promise<Done> => {
  const app = await queryOne(`SELECT id, user_id, job_id, cv_file_url, threshold_confirmed, threshold_confirmed_at FROM job_applications WHERE id = $1`, [id]);
  if (!app) throw new PushError('not_found');
  // The Case points at the candidate's Contact: make sure it is there first.
  let candidate = await rowOf('candidate', app.user_id);
  let contactId = candidate?.sf_id ?? undefined;
  if (!contactId) {
    const c = await pushOneRecorded('candidate', app.user_id);
    if (!c.ok) throw new PushError(`candidate_${c.error}`);
    contactId = c.sfId;
    candidate = await rowOf('candidate', app.user_id);
  }
  // An adopted Contact keeps the existing site's ID_cambium__c: the Case names it in A_CID_cambium__c, so the
  // new_applied Flow links the Case to that Contact (and not to none).
  const r = await sf.ensureApplicationCase({ _id: app.id, userId: app.user_id, jobId: app.job_id, candidateKey: candidate?.sf_legacy_cid ?? null,
    thresholdConfirmed: !!app.threshold_confirmed, thresholdConfirmedAt: app.threshold_confirmed_at }, contactId, row?.sf_id ?? undefined);
  // The CV used for THIS application goes on its Case, once — and only on a Case this site made (never on one it
  // merely found, which may already carry it).
  const key = app.cv_file_url ? String(app.cv_file_url) : '';
  if (key && key !== row?.synced_cv_key && (r.created || row?.sf_id === r.id)) {
    await sendCv(key, [r.id], `jobApplicationId:${id}`, r.id, contactId);
    return { ...r, contactId, cvKey: key };
  }
  return { ...r, contactId };
};

/** A quick (guest) application: its Contact, its Case, its CV (on the Case and the Contact). id = the guest id. */
const pushGuestApplication = async (id: string, row: Row | null): Promise<Done> => {
  const g = await queryOne(`SELECT id, application_id, job_id, full_name, email, phone_number, cv_key, threshold_confirmed, threshold_confirmed_at
    FROM guest_applications WHERE id = $1`, [id]);
  if (!g) throw new PushError('not_found');
  const contact = await sf.upsertGuestContact({ _id: g.id, fullName: g.full_name, email: g.email, phoneNumber: g.phone_number },
    row?.sf_contact_id ?? undefined);
  let r;
  try {
    r = await sf.ensureApplicationCase({ _id: g.application_id, userId: g.id, jobId: g.job_id,
      thresholdConfirmed: !!g.threshold_confirmed, thresholdConfirmedAt: g.threshold_confirmed_at }, contact.id, row?.sf_id ?? undefined);
  }
  catch (e) { throw new PushError(salesforceErrorCode(e), undefined, contact.id); }
  const key = g.cv_key ? String(g.cv_key) : '';
  let cvKey: string | undefined;
  if (key && key !== row?.synced_cv_key && (r.created || row?.sf_id === r.id)) {
    await sendCv(key, [r.id, contact.id], `guestId:${id}`, r.id, contact.id);
    cvKey = key;
  }
  return { ...r, contactId: contact.id, cvKey };
};

const pushEmployer = async (id: string, row: Row | null): Promise<Done> => {
  const e = await employerDAL.getEmployer(id);
  if (!e) throw new PushError('not_found');
  let r;
  try { r = await sf.upsertEmployer(e, { contactId: row?.sf_id ?? undefined, accountId: row?.sf_account_id ?? undefined }); }
  catch (err: any) { throw new PushError(salesforceErrorCode(err), undefined, undefined, err?.accountId); }
  // A new Contact: the employer's jobs sent earlier now get it (ContactId on their Case).
  if (r.created) {
    const jobs = await query<{ job_id: string }>(
      `SELECT e.job_id FROM employer_jobs e JOIN salesforce_sync s ON s.kind = 'job' AND s.record_id = e.job_id WHERE e.user_id = $1`, [id]);
    for (const j of jobs) await queueSalesforce('job', j.job_id);
  }
  return r;
};

const PUSH: Record<SyncKind, (id: string, row: Row | null) => Promise<Done>> = {
  job: pushJob, candidate: pushCandidate, application: pushApplication, guest_application: pushGuestApplication, employer: pushEmployer,
};

/** The quick-application table keeps its own "sent" mark (the staff list shows it). */
const markGuest = (id: string, error: string | null) => (error
  ? query(`UPDATE guest_applications SET salesforce_attempt_at = now(), salesforce_error = $2 WHERE id = $1`, [id, error])
  : query(`UPDATE guest_applications SET salesforce_sent_at = COALESCE(salesforce_sent_at, now()), salesforce_attempt_at = now(), salesforce_error = NULL WHERE id = $1`, [id]));

/** One record: push and record the outcome. No log entry here (callers write it first). */
const pushOneRecorded = async (kind: SyncKind, id: string): Promise<PushResult> => {
  if (!salesforceEnabled()) return { kind, id, ok: false, error: 'salesforce_disabled' };
  const before = await rowOf(kind, id);
  try {
    const r = await PUSH[kind](id, before);
    await recordOk(kind, id, before, r);
    if (kind === 'guest_application') await markGuest(id, null);
    return { kind, id, ok: true, sfId: r.id, created: r.created };
  } catch (e) {
    const code = codeOf(e);
    const partial = e instanceof PushError ? { sfId: e.sfId, contactId: e.contactId, accountId: e.accountId } : undefined;
    await recordError(kind, id, before, code, partial).catch(() => undefined);
    if (kind === 'guest_application') await markGuest(id, code).catch(() => undefined);
    console.error(`[salesforce] ${kind} ${id} failed: ${code}`);
    return { kind, id, ok: false, error: code };
  }
};

/** Person ids a push hands to Salesforce (for the log: "who was sent where"). */
const peopleOf = async (kind: SyncKind, ids: string[]): Promise<string[]> => {
  if (kind === 'candidate' || kind === 'employer' || kind === 'guest_application') return ids;
  if (kind === 'application' && ids.length) {
    const rows = await query<{ user_id: string }>(`SELECT DISTINCT user_id FROM job_applications WHERE id = ANY($1::text[])`, [ids]);
    return rows.map((r) => r.user_id);
  }
  return [];
};

/** Pushes these records (same kind) now. Strict log entry first; stops early if Salesforce refuses the login. */
export const pushRecords = async (actor: string, kind: SyncKind, ids: string[], place: string): Promise<PushResult[]> => {
  const valid = [...new Set(ids)].filter(isObjectId);
  if (!valid.length || !salesforceEnabled()) return valid.map((id) => ({ kind, id, ok: false, error: 'salesforce_disabled' }));
  const people = PEOPLE_KINDS.includes(kind) ? await peopleOf(kind, valid) : [];
  await writeAuditStrict(actor, 'salesforce.pushed', place, { kind, records: valid.slice(0, 1000), ...capIds(people), count: valid.length });
  const out: PushResult[] = [];
  for (const id of valid) {
    const r = await pushOneRecorded(kind, id);
    out.push(r);
    if (isAuthErrorCode(r.error)) break;
  }
  return out;
};

// ---- the queue ----
const QUEUE_GUARD: Record<SyncKind, string> = {
  // The existing site's jobs are pushed only after the cutover (legacy_state 'owned'); while mirrored, never.
  job: `EXISTS (SELECT 1 FROM jobs WHERE id = $2 AND NOT imported_from_live AND legacy_state IS DISTINCT FROM 'mirror')`,
  // The existing site's candidates are sent only after the cutover (legacy_state 'owned'); while mirrored, never.
  candidate: `EXISTS (SELECT 1 FROM users WHERE id = $2 AND 'user' = ANY(roles) AND legacy_state IS DISTINCT FROM 'mirror')`,
  employer: `EXISTS (SELECT 1 FROM users WHERE id = $2 AND 'employer' = ANY(roles))`,
  application: `EXISTS (SELECT 1 FROM job_applications WHERE id = $2)`,
  guest_application: `EXISTS (SELECT 1 FROM guest_applications WHERE id = $2)`,
};

/**
 * Marks a record to be sent (now, or after the wait of a running backoff). Off → does nothing. Never throws: a
 * change on the site never fails because of Salesforce.
 */
export const queueSalesforce = async (kind: SyncKind, id: string | null | undefined): Promise<void> => {
  if (!salesforceEnabled() || !id || !isObjectId(String(id))) return;
  try {
    await query(
      `INSERT INTO salesforce_sync (kind, record_id, queued_at, next_attempt_at, last_attempt_at, attempts)
       SELECT $1, $2, now(), now(), now(), 0 WHERE ${QUEUE_GUARD[kind]}
       ON CONFLICT (kind, record_id) DO UPDATE SET queued_at = now(),
         next_attempt_at = CASE WHEN salesforce_sync.fail_streak > 0 AND salesforce_sync.queued_at IS NOT NULL
                                 AND salesforce_sync.next_attempt_at IS NOT NULL THEN salesforce_sync.next_attempt_at ELSE now() END`,
      [kind, String(id)]);
    kickSalesforceWorker();
  } catch (e) {
    console.error(`[salesforce] could not queue ${kind} ${id}: ${safeErrorText(e)}`);
  }
};

/** Puts failed records (or those of one kind) back in the queue, due now. Returns how many. */
export const requeueFailed = async (kind?: SyncKind): Promise<number> => {
  const rows = await query(
    `UPDATE salesforce_sync SET queued_at = now(), next_attempt_at = now(), fail_streak = 0
      WHERE last_error_code IS NOT NULL AND last_error_code NOT IN ('imported_read_only', 'not_found') ${kind ? 'AND kind = $1' : ''}
      RETURNING kind`, kind ? [kind] : []);
  if (rows.length) kickSalesforceWorker();
  return rows.length;
};

/**
 * Records never sent (or changed since; applications: never sent). Excludes imported jobs and anything queued.
 * Counted for the admin screen only: nothing from before the switch-on is sent (owner's rule, 11.2026); a record
 * goes to Salesforce only when it is created or changed while Salesforce is on.
 */
export const pendingIds = async (kind: SyncKind, limit: number): Promise<string[]> => {
  const never = `s.record_id IS NULL OR (s.last_pushed_at IS NULL AND s.queued_at IS NULL)`;
  const sql: Record<SyncKind, string> = {
    job: `SELECT j.id FROM jobs j LEFT JOIN salesforce_sync s ON s.kind = 'job' AND s.record_id = j.id
           WHERE NOT j.imported_from_live AND j.legacy_state IS DISTINCT FROM 'mirror'
             -- an existing site's job already has its Case there: only a change made here after the cutover is pending
             AND (j.legacy_state IS NULL OR s.last_pushed_at IS NOT NULL)
             AND (${never} OR (s.queued_at IS NULL AND j.updated_at > s.last_pushed_at)) ORDER BY j.updated_at LIMIT $1`,
    candidate: `SELECT u.id FROM users u LEFT JOIN salesforce_sync s ON s.kind = 'candidate' AND s.record_id = u.id
           WHERE 'user' = ANY(u.roles) AND u.legacy_state IS DISTINCT FROM 'mirror'
             -- an existing site's candidate already has their Contact there: only a change made here after the cutover
             AND (u.legacy_state IS NULL OR s.last_pushed_at IS NOT NULL)
             AND (${never} OR (s.queued_at IS NULL AND u.updated_at > s.last_pushed_at)) ORDER BY u.updated_at LIMIT $1`,
    employer: `SELECT u.id FROM users u LEFT JOIN salesforce_sync s ON s.kind = 'employer' AND s.record_id = u.id
           WHERE 'employer' = ANY(u.roles) AND (${never} OR (s.queued_at IS NULL AND u.updated_at > s.last_pushed_at)) ORDER BY u.updated_at LIMIT $1`,
    application: `SELECT a.id FROM job_applications a LEFT JOIN salesforce_sync s ON s.kind = 'application' AND s.record_id = a.id
           WHERE ${never} ORDER BY a.created_at LIMIT $1`,
    guest_application: `SELECT g.id FROM guest_applications g LEFT JOIN salesforce_sync s ON s.kind = 'guest_application' AND s.record_id = g.id
           WHERE g.salesforce_sent_at IS NULL AND (${never}) ORDER BY g.created_at LIMIT $1`,
  };
  return (await query<{ id: string }>(sql[kind], [limit])).map((r) => r.id);
};

// ---- the worker ----
const BATCH = 25;
let running = false;
let kickTimer: NodeJS.Timeout | null = null;
let kickAt = 0;

/** Sends what is due now (one batch per kind, in push order). Returns counts. Only one run at a time per process. */
export const runDueNow = async (): Promise<{ pushed: number; failed: number; more: boolean }> => {
  if (!salesforceEnabled() || running) return { pushed: 0, failed: 0, more: false };
  running = true;
  let pushed = 0; let failed = 0; let more = false;
  try {
    // Claim the due rows (another instance skips them for 10 minutes; a crash leaves them due again after that).
    const claimed = await query<{ kind: SyncKind; record_id: string }>(
      `UPDATE salesforce_sync s SET next_attempt_at = now() + interval '10 minutes'
        FROM (SELECT kind, record_id FROM salesforce_sync WHERE queued_at IS NOT NULL AND next_attempt_at <= now()
               ORDER BY next_attempt_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED) d
       WHERE s.kind = d.kind AND s.record_id = d.record_id RETURNING s.kind, s.record_id`);
    more = claimed.length === BATCH;
    for (const kind of SYNC_KINDS) {
      const ids = claimed.filter((c) => c.kind === kind).map((c) => c.record_id);
      if (!ids.length) continue;
      const results = await pushRecords(SYSTEM_ACTOR, kind, ids, 'salesforce-sync');
      pushed += results.filter((r) => r.ok).length;
      failed += results.filter((r) => !r.ok).length;
      if (results.some((r) => isAuthErrorCode(r.error))) { more = false; break; } // the rest stays claimed for 10 min
    }
    if (pushed || failed) console.log(`[salesforce] sync: ${pushed} sent, ${failed} failed`);
  } catch (e) {
    console.error(`[salesforce] sync run failed: ${safeErrorText(e)}`);
  } finally {
    running = false;
  }
  return { pushed, failed, more };
};

/** Runs the worker soon (debounced), e.g. right after a change was queued. */
export const kickSalesforceWorker = (delayMs = 1500) => {
  if (!salesforceEnabled()) return;
  // One timer; a sooner kick replaces a later one (e.g. the first run after boot).
  if (kickTimer && kickAt <= Date.now() + delayMs) return;
  if (kickTimer) clearTimeout(kickTimer);
  kickAt = Date.now() + delayMs;
  kickTimer = setTimeout(async () => {
    kickTimer = null;
    const r = await runDueNow();
    if (r.more) kickSalesforceWorker(200);
  }, delayMs);
  kickTimer.unref?.();
};

/** At boot: every minute (and once soon). Off → nothing is started. */
export const startSalesforceWorker = () => {
  if (!salesforceEnabled()) return;
  kickSalesforceWorker(20_000);
  setInterval(() => kickSalesforceWorker(0), 60_000).unref();
};

// ---- state for admins and the internal API (ids and codes only) ----
export const syncSummary = async () => {
  const rows = await query<{ kind: SyncKind; state: string; n: number }>(
    `SELECT kind, CASE WHEN queued_at IS NOT NULL AND last_error_code IS NOT NULL THEN 'retrying'
                       WHEN queued_at IS NOT NULL THEN 'queued'
                       WHEN last_error_code IS NOT NULL THEN 'failed' ELSE 'synced' END AS state, COUNT(*)::int AS n
       FROM salesforce_sync GROUP BY 1, 2`);
  const counts = Object.fromEntries(SYNC_KINDS.map((k) => [k, { synced: 0, queued: 0, retrying: 0, failed: 0, neverSent: 0 }])) as
    Record<SyncKind, { synced: number; queued: number; retrying: number; failed: number; neverSent: number }>;
  for (const r of rows) if (counts[r.kind]) (counts[r.kind] as any)[r.state] = r.n;
  for (const k of SYNC_KINDS) counts[k].neverSent = (await pendingIds(k, 100000)).length;
  const failures = await query(
    `SELECT kind, record_id AS "recordId", sf_id AS "sfId", last_error_code AS "code", attempts, fail_streak AS "failStreak",
            last_attempt_at AS "lastAttemptAt", next_attempt_at AS "nextAttemptAt", queued_at IS NOT NULL AS "willRetry"
       FROM salesforce_sync WHERE last_error_code IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 50`);
  const last = await queryOne<{ at: string | null }>(`SELECT max(last_pushed_at) AS at FROM salesforce_sync`);
  return { counts, failures, lastPushedAt: last?.at ?? null };
};

export const syncState = async (f: { kind?: SyncKind; status?: 'error' | 'synced'; limit: number; offset: number }) => {
  const params: any[] = [];
  const where: string[] = [];
  if (f.kind) { params.push(f.kind); where.push(`kind = $${params.length}`); }
  if (f.status === 'error') where.push(`last_error_code IS NOT NULL`);
  if (f.status === 'synced') where.push(`last_pushed_at IS NOT NULL AND last_error_code IS NULL`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = (await query(
    `SELECT kind, record_id AS "recordId", sf_id AS "sfId", last_pushed_at AS "lastPushedAt", last_attempt_at AS "lastAttemptAt",
            last_error_code AS "lastErrorCode", attempts, queued_at, last_pushed_at, last_error_code FROM salesforce_sync ${w}
      ORDER BY last_attempt_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params))
    .map(({ queued_at, last_pushed_at, last_error_code, ...r }: any) => ({ ...r, state: syncRowState({ queued_at, last_pushed_at, last_error_code }) }));
  const pending = Object.fromEntries(await Promise.all((['job', 'candidate', 'application'] as SyncKind[]).map(async (k) => [k, (await pendingIds(k, 10000)).length])));
  return { rows, pending };
};
