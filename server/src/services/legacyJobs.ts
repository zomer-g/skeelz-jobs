/* ============================================================================
 *  The existing site's jobs (owner's decision, 20.11.2026): every job of the
 *  existing site lives here too, under the same _id and job number, so links,
 *  applications and Salesforce stay on the same records. LEGACY_JOBS_MODE:
 *
 *   off     nothing is read; jobs already here keep their state.
 *   mirror  until the cutover the existing site manages its jobs. Every few
 *           minutes (LEGACY_JOBS_MIRROR_MINUTES) the mirror READS their Position
 *           Cases from Salesforce (only what changed since the last read) and
 *           updates the copies here: status and fields. Read-only here
 *           (jobDAL.assertJobEditable 409 job_read_only + the DB trigger
 *           jobs_legacy_guard), never pushed. No application is taken for them here
 *           (owner, 23.11.2026: 409 job_on_existing_site); after the
 *           cutover an application Case names the job's _id (the same Position Case).
 *           The existing site's public API (LEGACY_PUBLIC_API, GET only) adds
 *           the job number and the description as formatted there, and a job on
 *           its board that has no Case yet.
 *   owned   the cutover: at boot every mirrored job becomes this site's
 *           ('owned'); the mirror stops; staff manage them here, and a change is
 *           pushed (through the queue) to the SAME Position Case, found by its
 *           stored id — never a new one, never marked Beta. Back to `mirror` =
 *           the rollback (the copies follow Salesforce again).
 *
 *  Nothing is written to Salesforce here, and nothing is deleted anywhere.
 *  No candidate data is read or written: a job's contact person (as published
 *  on the job) is the only person-related field, and it is never logged.
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { pool, query, queryOne } from '../config/db.js';
import { sfQueryAll } from '../config/salesforceConfig.js';
import { writeAudit } from '../security/audit.js';
import { safeErrorText } from '../security/pure.js';
import { salesforceErrorCode } from '../internalApi/pure.js';
import { sanitizeJobHtml } from '../utils/sanitize.js';
import { describeObject, soqlId } from './salesforceService.js';
import {
  CaseContext, LEGACY_CASE_FIELDS, MirroredJob, PublicJob, caseToJob, changedColumns, isLegacyJobId, nextWatermark, publicToJob, soqlDateTime,
} from './legacyJobsPure.js';

export const LEGACY_ACTOR = 'system:legacy-jobs';
const STATE_KEY = 'legacy_jobs.mirror';

export const legacyMode = () => appConfig.salesforce.legacyJobsMode;
/** The mirror reads only with Salesforce on (and valid) and LEGACY_JOBS_MODE=mirror. */
export const mirrorActive = () => appConfig.salesforce.enableSalesforce && legacyMode() === 'mirror';

export type MirrorCounts = { read: number; created: number; updated: number; unchanged: number; closed: number; skipped: Record<string, number> };
/** Bump to make the next run (after a deploy) a full read: a rule that changes how stored copies are filled
 *  (2 = the job number from the Case's link, 20.11.2026) reaches every copy, not only the changed ones. */
export const FULL_READ_VERSION = 2;
export type MirrorState = {
  fullReadVersion?: number;
  watermark: string | null; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null;
  last: MirrorCounts | null; publicApi: 'not_set' | 'ok' | string;
};
const emptyCounts = (): MirrorCounts => ({ read: 0, created: 0, updated: 0, unchanged: 0, closed: 0, skipped: {} });

const readState = async (): Promise<MirrorState> => {
  const r = await queryOne<{ value: MirrorState }>(`SELECT value FROM app_settings WHERE key = $1`, [STATE_KEY]);
  return { watermark: null, lastRunAt: null, lastOkAt: null, lastError: null, last: null, publicApi: 'not_set', ...(r?.value ?? {}) };
};
const saveState = (s: MirrorState) => query(
  `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [STATE_KEY, JSON.stringify(s), LEGACY_ACTOR]);

/** One transaction in which the mirror (or the mode switch) may change the existing site's jobs (db.ts jobs_legacy_guard). */
export const asLegacyWriter = async <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL skeelz.legacy_writer = 'on'`);
    const out = await fn((sql, params) => client.query(sql, params as any[]));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

// ---- the existing site's public API (GET only) ----
const PUBLIC_TIMEOUT_MS = 15_000;
const getPublic = async (path: string): Promise<any> => {
  const base = appConfig.salesforce.legacyPublicApi;
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'skeelz-jobs-legacy-mirror' }, signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`public ${res.status}`), { code: `public_http_${res.status}` });
  return res.json();
};

/** The public board (jobs by id) and, on the way, its cities and skills (added or renamed here, never removed). */
const readPublicBoard = async (): Promise<{ jobs: Map<string, PublicJob>; code: string }> => {
  if (!appConfig.salesforce.legacyPublicApi) return { jobs: new Map(), code: 'not_set' };
  try {
    const [locations, skills, board] = await Promise.all([getPublic('/locations'), getPublic('/skills'), getPublic('/jobs/active')]);
    for (const l of (locations?.data ?? []) as any[]) {
      const sym = Number(l?.citySymbol);
      if (!Number.isInteger(sym) || !l?.city) continue;
      await query(
        `INSERT INTO locations (city_symbol, city, district, identifier) VALUES ($1,$2,$3,$4)
         ON CONFLICT (city_symbol) DO UPDATE SET city = EXCLUDED.city, district = EXCLUDED.district`,
        [sym, String(l.city), String(l.district ?? ''), Number(l.identifier ?? sym)]);
    }
    for (const s of ((skills?.data?.skills ?? skills?.data ?? []) as any[])) {
      if (!isLegacyJobId(s?._id) || !s?.name) continue;
      await query(`INSERT INTO skills (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, [String(s._id).toLowerCase(), String(s.name)]);
    }
    const jobs = new Map<string, PublicJob>();
    for (const j of ((board?.data?.jobs ?? []) as PublicJob[])) if (isLegacyJobId(j?._id)) jobs.set(String(j._id).toLowerCase(), j);
    return { jobs, code: 'ok' };
  } catch (e: any) {
    return { jobs: new Map(), code: e?.code ?? 'public_unreachable' };
  }
};

const contextBase = async (): Promise<Omit<CaseContext, 'publicJob' | 'existingDescription'>> => {
  const skills = await query<{ id: string; name: string }>(`SELECT id, name FROM skills`);
  const cities = await query<{ city_symbol: number; city: string }>(`SELECT city_symbol, city FROM locations`);
  return {
    skills: { ids: new Set(skills.map((s) => s.id.toLowerCase())), byName: new Map(skills.map((s) => [s.name.trim().toLowerCase(), s.id.toLowerCase()])) },
    cityByName: new Map(cities.map((c) => [c.city.trim().toLowerCase(), c.city_symbol])),
    sanitize: sanitizeJobHtml,
  };
};

type Stored = Record<string, any> & { id: string; job_id: number; legacy_state: string | null; imported_from_live: boolean; legacy_sf_id: string | null };

/** Writes one job read from the existing site. Returns what happened (or a skip code). */
const storeJob = async (j: MirroredJob, stored: Stored | undefined): Promise<'created' | 'updated' | 'unchanged' | string> => {
  if (stored && (stored.legacy_state !== 'mirror')) return stored.legacy_state === 'owned' ? 'owned_here' : 'not_legacy';
  if (!stored) {
    // The existing site's number, unless a job made here already has it (then the next free one).
    const taken = j.jobNumber ? await queryOne(`SELECT 1 FROM jobs WHERE job_id = $1`, [j.jobNumber]) : null;
    const number = taken ? null : j.jobNumber;
    const r = await asLegacyWriter((q) => q(
      `INSERT INTO jobs (id, job_id, title, job_scope, company_name, publish_date, city_symbol, description, contact_person_name,
                         contact_person_phone, contact_person_email, external_link, upload_by, status, comments, required_skills,
                         is_sponsored, is_marked, is_self_apply, guest_mode_override, created_at, updated_at,
                         legacy_state, legacy_sf_id, legacy_synced_at)
       VALUES ($1, COALESCE($2::int, nextval('jobs_job_id_seq')), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
               CASE WHEN $19 THEN 'self' END, $20, $21, 'mirror', $22, now())
       ON CONFLICT (id) DO NOTHING`,
      [j.id, number, j.title, j.jobScope, j.companyName, j.publishDate, j.citySymbol, j.description, j.contactPersonName,
        j.contactPersonPhone, j.contactPersonEmail, j.externalLink, j.uploadBy, j.status, j.comments, j.requiredSkills,
        j.isSponsored, j.isMarked, j.isSelfApply, j.createdAt, j.updatedAt, j.sfId]));
    return r.rowCount ? 'created' : 'not_legacy';
  }
  const changes = changedColumns(stored, j);
  // The existing site's number, when the copy got another one (read before the number was known) and it is free.
  if (j.jobNumber && Number(stored.job_id) !== j.jobNumber && !(await queryOne(`SELECT 1 FROM jobs WHERE job_id = $1`, [j.jobNumber]))) {
    changes.push({ column: 'job_id', value: j.jobNumber });
  }
  const sfIdChanged = !!j.sfId && j.sfId !== stored.legacy_sf_id;
  if (!changes.length && !sfIdChanged) {
    await asLegacyWriter((q) => q(`UPDATE jobs SET legacy_synced_at = now() WHERE id = $1 AND legacy_state = 'mirror'`, [j.id]));
    return 'unchanged';
  }
  const sets = changes.map((c, i) => `${c.column} = $${i + 2}`);
  const values = changes.map((c) => c.value);
  values.push(j.sfId ?? stored.legacy_sf_id);
  sets.push(`legacy_sf_id = $${values.length + 1}`);
  if (changes.length) { values.push(j.updatedAt); sets.push(`updated_at = $${values.length + 1}`); }
  await asLegacyWriter((q) => q(`UPDATE jobs SET ${sets.join(', ')}, legacy_synced_at = now() WHERE id = $1 AND legacy_state = 'mirror'`, [j.id, ...values]));
  return changes.length ? 'updated' : 'unchanged';
};

let running = false;

/**
 * One read of the existing site's jobs. `full` re-reads every Position Case (the first run does anyway); otherwise
 * only those changed since the last run. Returns the counts (also stored for the admin screen).
 */
export const runLegacyMirror = async (opts: { full?: boolean; actor?: string } = {}): Promise<{ ran: boolean; reason?: string; counts?: MirrorCounts; truncated?: boolean }> => {
  if (!mirrorActive()) return { ran: false, reason: legacyMode() !== 'mirror' ? 'mode_not_mirror' : 'salesforce_disabled' };
  if (running) return { ran: false, reason: 'already_running' };
  running = true;
  const state = await readState();
  const counts = emptyCounts();
  const skip = (code: string) => { counts.skipped[code] = (counts.skipped[code] ?? 0) + 1; };
  state.lastRunAt = new Date().toISOString();
  try {
    const board = await readPublicBoard();
    state.publicApi = board.code;
    const base = await contextBase();

    // Read-only SOQL: every Position Case with a job id, whatever its Account (the team moves many to the employer's
    // Account; 958 of 1,840 in the org, 11.2026); this site's own Cases (Beta) are left out when the org has the field
    // (a job made here is skipped anyway: not_legacy); only what changed since the watermark unless `full`.
    const describe = await describeObject('Case');
    const has = (f: string) => describe.fields.some((x) => x.name === f);
    const fields = ['Id', 'CreatedDate', 'LastModifiedDate', ...LEGACY_CASE_FIELDS.filter(has)];
    const s = appConfig.salesforce;
    const where = [`RecordTypeId = '${soqlId(s.jobCaseRecordTypeId)}'`, `PID_cambium__c != null`];
    if (has(s.betaField)) where.push(`${s.betaField} = false`);
    const full = !!opts.full || (state.fullReadVersion ?? 0) < FULL_READ_VERSION;
    const since = full ? null : state.watermark;
    if (since) where.push(`LastModifiedDate > ${soqlDateTime(since)}`);
    const { records, truncated } = await sfQueryAll<Record<string, unknown>>(
      `SELECT ${fields.join(', ')} FROM Case WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate ASC`);
    counts.read = records.length;

    const seenIds = new Set<string>();
    const ids = records.map((c) => String(c.PID_cambium__c ?? '').toLowerCase()).filter(isLegacyJobId);
    const storedRows = ids.length || board.jobs.size
      ? await query<Stored>(`SELECT * FROM jobs WHERE id = ANY($1::text[])`, [[...new Set([...ids, ...board.jobs.keys()])]]) : [];
    const stored = new Map(storedRows.map((r) => [r.id, r]));

    for (const c of records) {
      const pid = String(c.PID_cambium__c ?? '').toLowerCase();
      // Two Cases for one job: the newest wins (records come oldest first).
      const result = caseToJob(c, { ...base, publicJob: board.jobs.get(pid), existingDescription: stored.get(pid)?.description ?? null });
      if (!result.ok) { skip(result.code); continue; }
      seenIds.add(result.job.id);
      try {
        const outcome = await storeJob(result.job, stored.get(result.job.id));
        if (outcome === 'created' || outcome === 'updated' || outcome === 'unchanged') counts[outcome]++;
        else skip(outcome);
        if (outcome === 'created' || outcome === 'updated') {
          stored.set(result.job.id, (await queryOne<Stored>(`SELECT * FROM jobs WHERE id = $1`, [result.job.id]))!);
        }
      } catch (e) {
        skip('db_error');
        console.error(`[legacy-jobs] job ${result.job.id}: ${safeErrorText(e)}`);
      }
    }

    // On the public board but no Case read: added from the board alone (Salesforce updates it once its Case comes).
    for (const [id, p] of board.jobs) {
      if (seenIds.has(id) || stored.has(id)) continue;
      const result = publicToJob(p, base);
      if (!result.ok) { skip(result.code); continue; }
      try {
        const outcome = await storeJob(result.job, undefined);
        if (outcome === 'created') counts.created++; else skip(outcome);
      } catch (e) {
        skip('db_error');
        console.error(`[legacy-jobs] job ${id}: ${safeErrorText(e)}`);
      }
    }
    // A job read from the board alone (no Case) that left the board: closed there, so closed here.
    if (board.code === 'ok' && board.jobs.size) {
      const gone = await asLegacyWriter((q) => q(
        `UPDATE jobs SET status = 'Closed', updated_at = now(), legacy_synced_at = now()
          WHERE legacy_state = 'mirror' AND legacy_sf_id IS NULL AND status <> 'Closed' AND NOT (id = ANY($1::text[]))`, [[...board.jobs.keys()]]));
      counts.closed = gone.rowCount ?? 0;
    }

    state.watermark = truncated ? state.watermark : nextWatermark(state.watermark, records.map((c) => String(c.LastModifiedDate ?? '')));
    if (full && !truncated) state.fullReadVersion = FULL_READ_VERSION;
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    state.last = counts;
    await saveState(state);
    if (counts.created || counts.updated || counts.closed || opts.actor) {
      await writeAudit(opts.actor ?? LEGACY_ACTOR, 'legacy_jobs.mirrored', 'salesforce', {
        full, read: counts.read, created: counts.created, updated: counts.updated, closed: counts.closed, skipped: counts.skipped, publicApi: board.code,
      });
    }
    if (counts.created || counts.updated || counts.closed || Object.keys(counts.skipped).length || board.code !== 'ok') {
      // Counts and codes only (no job content, no contact details).
      const skipped = Object.entries(counts.skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      console.log(`[legacy-jobs] read ${counts.read}: ${counts.created} added, ${counts.updated} updated, ${counts.closed} closed; skipped: ${skipped}; public board: ${board.code}`);
    }
    return { ran: true, counts, truncated };
  } catch (e) {
    state.lastError = salesforceErrorCode(e);
    state.last = counts;
    await saveState(state).catch(() => undefined);
    console.error(`[legacy-jobs] mirror run failed: ${state.lastError}`);
    return { ran: false, reason: state.lastError ?? 'error', counts };
  } finally {
    running = false;
  }
};

/**
 * At boot: the mode decides who manages the existing site's jobs. owned = the cutover (mirror → owned); mirror = the
 * rollback (owned → mirror). off changes nothing. Logged when anything moved.
 */
export const applyLegacyJobsMode = async (): Promise<{ moved: number; to: string | null }> => {
  const mode = legacyMode();
  if (mode === 'off') return { moved: 0, to: null };
  const [from, to] = mode === 'owned' ? ['mirror', 'owned'] : ['owned', 'mirror'];
  const r = await asLegacyWriter((q) => q(`UPDATE jobs SET legacy_state = $2 WHERE legacy_state = $1`, [from, to]));
  const moved = r.rowCount ?? 0;
  if (moved) {
    await writeAudit(LEGACY_ACTOR, to === 'owned' ? 'legacy_jobs.taken_over' : 'legacy_jobs.returned_to_mirror', 'jobs', { count: moved, mode });
    console.log(`[legacy-jobs] ${moved} jobs of the existing site are now ${to === 'owned' ? 'managed here' : 'mirrored again'}`);
  }
  return { moved, to };
};

/** At boot: the periodic read (mirror mode with Salesforce on only). */
export const startLegacyMirror = () => {
  if (!mirrorActive()) return;
  const every = appConfig.salesforce.legacyMirrorMinutes * 60_000;
  setTimeout(() => { void runLegacyMirror(); }, 30_000).unref?.();
  setInterval(() => { void runLegacyMirror(); }, every).unref();
};

// ---- for admins (ids, counts and codes only) ----
export const legacyJobsSummary = async () => {
  const rows = await query<{ legacy_state: string; status: string; with_case: boolean; n: number }>(
    `SELECT legacy_state, status, legacy_sf_id IS NOT NULL AS with_case, COUNT(*)::int AS n FROM jobs WHERE legacy_state IS NOT NULL GROUP BY 1, 2, 3`);
  const sum = (f: (r: typeof rows[number]) => boolean) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  return {
    mode: legacyMode(),
    mirrorActive: mirrorActive(),
    everyMinutes: appConfig.salesforce.legacyMirrorMinutes,
    publicApiSet: !!appConfig.salesforce.legacyPublicApi,
    state: await readState(),
    jobs: {
      mirror: sum((r) => r.legacy_state === 'mirror'), owned: sum((r) => r.legacy_state === 'owned'),
      active: sum((r) => r.status === 'Active'), suspended: sum((r) => r.status === 'Suspended'), closed: sum((r) => r.status === 'Closed'),
      withoutCase: sum((r) => !r.with_case),
    },
  };
};

const LIST_CAP = 50;
/**
 * The cutover report (READ ONLY, also while off as long as the settings are complete): the existing site's Position
 * Cases against the jobs here, and how candidates' Contacts were matched. Job ids and counts only; no candidate field
 * (the candidate part comes from this site's own sync table: no email is sent to Salesforce for it).
 */
export const cutoverReport = async () => {
  const s = appConfig.salesforce;
  const jobs: Record<string, unknown> = {};
  try {
    const describe = await describeObject('Case');
    const where = [`RecordTypeId = '${soqlId(s.jobCaseRecordTypeId)}'`, `PID_cambium__c != null`];
    if (describe.fields.some((f) => f.name === s.betaField)) where.push(`${s.betaField} = false`);
    const { records, truncated } = await sfQueryAll<{ Id: string; PID_cambium__c: string; PStatus__c: string | null }>(
      `SELECT Id, PID_cambium__c, PStatus__c FROM Case WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate ASC`);
    const sfByPid = new Map<string, { id: string; status: string }>();
    const byStatus: Record<string, number> = {};
    for (const r of records) {
      const pid = String(r.PID_cambium__c ?? '').toLowerCase();
      const st = r.PStatus__c || '(empty)';
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      if (isLegacyJobId(pid)) sfByPid.set(pid, { id: r.Id, status: r.PStatus__c === 'Active' ? 'Active' : r.PStatus__c || 'Closed' });
    }
    const here = await query<{ id: string; status: string; legacy_state: string | null }>(
      `SELECT id, status, legacy_state FROM jobs WHERE id = ANY($1::text[]) OR legacy_state IS NOT NULL`, [[...sfByPid.keys()]]);
    const hereById = new Map(here.map((r) => [r.id, r]));
    const notHere = [...sfByPid.keys()].filter((id) => !hereById.get(id));
    const madeHere = [...sfByPid.keys()].filter((id) => hereById.get(id) && !hereById.get(id)!.legacy_state);
    const activeThereNotHere = [...sfByPid].filter(([id, c]) => c.status === 'Active' && hereById.get(id)?.legacy_state && hereById.get(id)!.status !== 'Active').map(([id]) => id);
    const activeHereNotThere = here.filter((r) => r.legacy_state && r.status === 'Active' && sfByPid.get(r.id) && sfByPid.get(r.id)!.status !== 'Active').map((r) => r.id);
    const noCase = here.filter((r) => r.legacy_state && !sfByPid.has(r.id)).map((r) => r.id);
    jobs.ok = true;
    Object.assign(jobs, {
      positionCases: records.length, truncated, byStatus,
      notHere: { count: notHere.length, ids: notHere.slice(0, LIST_CAP) },
      sameIdMadeHere: { count: madeHere.length, ids: madeHere.slice(0, LIST_CAP) },
      activeThereNotHere: { count: activeThereNotHere.length, ids: activeThereNotHere.slice(0, LIST_CAP) },
      activeHereNotThere: { count: activeHereNotThere.length, ids: activeHereNotThere.slice(0, LIST_CAP) },
      hereWithoutCase: { count: noCase.length, ids: noCase.slice(0, LIST_CAP) },
    });
  } catch (e) {
    jobs.ok = false;
    jobs.code = salesforceErrorCode(e);
  }
  const c = await queryOne<{ total: number; sent: number; adopted: number; ambiguous: number; own: number }>(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE 'user' = ANY(roles)) AS total,
            COUNT(*) FILTER (WHERE s.sf_id IS NOT NULL)::int AS sent,
            COUNT(*) FILTER (WHERE s.sf_legacy_cid IS NOT NULL)::int AS adopted,
            COUNT(*) FILTER (WHERE s.sf_match = 'email_ambiguous')::int AS ambiguous,
            COUNT(*) FILTER (WHERE s.sf_id IS NOT NULL AND s.sf_legacy_cid IS NULL)::int AS own
       FROM salesforce_sync s WHERE s.kind = 'candidate'`);
  return {
    at: new Date().toISOString(),
    betaMark: s.betaMarkOn,
    legacy: await legacyJobsSummary(),
    legacyCandidates: await (await import('./legacyCandidates.js')).legacyCandidatesSummary(),
    jobs,
    candidates: {
      total: c?.total ?? 0, inSalesforce: c?.sent ?? 0, adoptedByEmail: c?.adopted ?? 0, ambiguousEmail: c?.ambiguous ?? 0,
      madeHere: c?.own ?? 0, notSent: Math.max(0, (c?.total ?? 0) - (c?.sent ?? 0)),
    },
  };
};
