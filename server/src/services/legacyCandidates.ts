/* ============================================================================
 *  The existing site's candidates (owner's decisions, 20.11.2026). LEGACY_CANDIDATES_MODE:
 *
 *   off     nothing is read; candidates already here keep their state.
 *   mirror  until the cutover every registered candidate of the existing site
 *           (Contacts of LEGACY_CANDIDATE_ACCOUNTS: the candidates' Account and
 *           the Retrain candidates' Account) has a copy here, READ from
 *           Salesforce every LEGACY_CANDIDATES_MIRROR_MINUTES (default 60; only what changed; all of it once a
 *           day, for CV files added without a Contact change). Quick applicants
 *           (no date of birth and no gender in the candidates' Account) are not
 *           copied. The copy is read-only: the candidate signs in with the same
 *           (verified) email and VIEWS their details, never edits them
 *           (CandidateReadOnlyError 409 candidate_read_only + the DB trigger
 *           users_legacy_guard). They apply to jobs made on this site (owner,
 *           23.11.2026; not to the existing site's jobs: nobody does). Staff
 *           see them like any candidate, through the same hand-overs. The CV is
 *           never copied: cv_file_url points at the Contact's newest file
 *           ('sf:<ContentVersion id>', services/legacyCvs.ts) and it is opened
 *           from Salesforce only when someone opens it.
 *           An account made here with the same email is linked (its empty
 *           fields filled once) and stays this site's (not read-only).
 *   owned   the cutover: at boot every mirrored candidate becomes an ordinary
 *           candidate ('owned'); the mirror stops; their changes go (through the
 *           queue) to the SAME Contact, in full (never clearing a field, never
 *           ID_cambium__c or the Account, never Beta). Back to `mirror` = the
 *           rollback (read-only again; what they changed here is kept).
 *
 *  Nothing is written to Salesforce here and nothing is deleted there. Logs and
 *  the activity log get counts and codes only: never a name, email or phone.
 * ========================================================================== */
import { isCandidate } from '../models/enums.js';
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import { sfQueryAll } from '../config/salesforceConfig.js';
import { writeAudit } from '../security/audit.js';
import { safeErrorText } from '../security/pure.js';
import { salesforceErrorCode } from '../internalApi/pure.js';
import { isObjectId, newObjectId } from '../utils/ids.js';
import { describeObject, soqlId } from './salesforceService.js';
import { asLegacyWriter } from './legacyJobs.js';
import { nextWatermark, soqlDateTime } from './legacyJobsPure.js';
import {
  CandidateContext, CvFile, LEGACY_CONTACT_FIELDS, MirroredCandidate, changedCandidateColumns, contactToCandidate, fillEmptyColumns,
  newestCvs, sfCvKey,
} from './legacyCandidatesPure.js';

export const LEGACY_CANDIDATES_ACTOR = 'system:legacy-candidates';
const STATE_KEY = 'legacy_candidates.mirror';
const FULL_EVERY_MS = 24 * 3_600_000;

export const candidatesMode = () => appConfig.salesforce.legacyCandidatesMode;
export const candidatesMirrorActive = () => appConfig.salesforce.enableSalesforce && candidatesMode() === 'mirror';

export type CandidateCounts = { read: number; created: number; updated: number; unchanged: number; linked: number; skipped: Record<string, number> };
/** Bump when a rule changes how copies are filled, so the next run is a full read. */
export const CANDIDATES_FULL_READ_VERSION = 1;
export type CandidatesState = {
  fullReadVersion?: number; lastFullAt?: string | null;
  watermark: string | null; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; last: CandidateCounts | null;
};
const emptyCounts = (): CandidateCounts => ({ read: 0, created: 0, updated: 0, unchanged: 0, linked: 0, skipped: {} });

const readState = async (): Promise<CandidatesState> => {
  const r = await queryOne<{ value: CandidatesState }>(`SELECT value FROM app_settings WHERE key = $1`, [STATE_KEY]);
  return { watermark: null, lastRunAt: null, lastOkAt: null, lastError: null, last: null, ...(r?.value ?? {}) };
};
const saveState = (s: CandidatesState) => query(
  `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [STATE_KEY, JSON.stringify(s), LEGACY_CANDIDATES_ACTOR]);

const context = async (): Promise<CandidateContext> => {
  const skills = await query<{ id: string }>(`SELECT id FROM skills`);
  const cities = await query<{ city_symbol: number; city: string }>(`SELECT city_symbol, city FROM locations`);
  return {
    quickAccounts: new Set([appConfig.salesforce.contactsAccountId].filter(Boolean)),
    skillIds: new Set(skills.map((s) => s.id.toLowerCase())),
    citySymbols: new Set(cities.map((c) => Number(c.city_symbol))),
    cityByName: new Map(cities.map((c) => [c.city.trim().toLowerCase(), Number(c.city_symbol)])),
  };
};

/** The newest CV file of each of these Contacts (read-only; 200 ids a query). */
const readCvs = async (contactIds: string[]): Promise<Map<string, CvFile>> => {
  const out = new Map<string, CvFile>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const ids = contactIds.slice(i, i + 200).map((id) => `'${soqlId(id)}'`).join(',');
    const { records } = await sfQueryAll<Record<string, any>>(
      `SELECT LinkedEntityId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.LatestPublishedVersionId,
              ContentDocument.ContentModifiedDate FROM ContentDocumentLink WHERE LinkedEntityId IN (${ids})`);
    for (const [k, v] of newestCvs(records)) out.set(k, v);
  }
  return out;
};

type Stored = Record<string, any> & { id: string; role: string; legacy_state: string | null; legacy_sf_id: string | null };

/** The sync row that sends an owned candidate's changes to their own Contact (never a new one). */
const seedSync = (userId: string, m: MirroredCandidate, cvKey: string | null, match: string) => query(
  `INSERT INTO salesforce_sync (kind, record_id, sf_id, sf_legacy_cid, sf_match, synced_cv_key, last_attempt_at, attempts)
   VALUES ('candidate', $1, $2, $3, $4, $5, now(), 0)
   ON CONFLICT (kind, record_id) DO UPDATE SET sf_id = EXCLUDED.sf_id, sf_legacy_cid = EXCLUDED.sf_legacy_cid, sf_match = EXCLUDED.sf_match,
     synced_cv_key = COALESCE(EXCLUDED.synced_cv_key, salesforce_sync.synced_cv_key)
   WHERE salesforce_sync.sf_id IS NULL OR salesforce_sync.sf_match = 'mirror'`,
  [userId, m.sfId, m.cid ?? userId, match, cvKey]);

const phoneFree = async (phone: string | null, exceptId: string | null) =>
  !phone || !(await queryOne(`SELECT 1 FROM users WHERE phone_number = $1 AND id IS DISTINCT FROM $2`, [phone, exceptId]));

/** Writes one candidate read from the existing site. Returns what happened, or a skip code. */
const storeCandidate = async (m: MirroredCandidate, cv: CvFile | undefined, ambiguous: boolean): Promise<string> => {
  if (await queryOne(`SELECT 1 FROM legacy_candidates_removed WHERE sf_id = $1`, [m.sfId])) return 'removed_here';
  const cvKey = cv ? sfCvKey(cv.versionId) : null;
  const bySf = await queryOne<Stored>(`SELECT * FROM users WHERE legacy_sf_id = $1`, [m.sfId]);
  const byEmail = bySf ? null : await queryOne<Stored>(`SELECT * FROM users WHERE lower(email) = $1`, [m.email]);
  const stored = bySf ?? byEmail;

  if (!stored) {
    const id = m.cid && isObjectId(m.cid) && !(await queryOne(`SELECT 1 FROM users WHERE id = $1`, [m.cid.toLowerCase()])) ? m.cid.toLowerCase() : newObjectId();
    const phone = (await phoneFree(m.phoneNumber, null)) ? m.phoneNumber : null;
    await asLegacyWriter((q) => q(
      `INSERT INTO users (id, first_name, last_name, email, phone_number, date_of_birth, gender, city_symbol, password, skills,
                          cv_file_url, has_applied_to_job, role, legacy_state, legacy_sf_id, legacy_cid, legacy_match, legacy_cv, legacy_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',$9,$10,false,'user','mirror',$11,$12,$13,$14::jsonb,now())`,
      [id, m.firstName, m.lastName, m.email, phone, m.dateOfBirth, m.gender, m.citySymbol, m.skills, cvKey ?? '',
        m.sfId, m.cid, ambiguous ? 'ambiguous' : null, cv ? JSON.stringify(cv) : null]));
    await seedSync(id, m, cvKey, 'mirror');
    return m.phoneNumber && !phone ? 'created_phone_shared' : 'created';
  }

  if (!isCandidate(stored)) return 'not_candidate'; // also a candidate who is staff / an employer too: still mirrored
  if (stored.legacy_state === 'owned') return 'owned_here';

  if (!stored.legacy_state) {
    // An account made here (or linked earlier) with this email: it stays this site's. Linked once, empty fields filled.
    if (stored.legacy_sf_id) return 'account_here';
    const fill = fillEmptyColumns(stored, m);
    if (fill.phone_number && !(await phoneFree(String(fill.phone_number), stored.id))) delete fill.phone_number;
    const cols = Object.keys(fill);
    await asLegacyWriter((q) => q(
      `UPDATE users SET ${[...cols.map((c, i) => `${c} = $${i + 2}`), `legacy_sf_id = $${cols.length + 2}`, `legacy_cid = $${cols.length + 3}`,
        `legacy_synced_at = now()`].join(', ')}${cols.length ? ', updated_at = now()' : ''} WHERE id = $1 AND legacy_state IS NULL`,
      [stored.id, ...Object.values(fill), m.sfId, m.cid]));
    // Its own Contact, if it has none yet, is this one (the queue then updates it, carefully: an adopted Contact).
    await query(
      `INSERT INTO salesforce_sync (kind, record_id, sf_id, sf_legacy_cid, sf_match, last_attempt_at, attempts)
       VALUES ('candidate', $1, $2, $3, 'email', now(), 0)
       ON CONFLICT (kind, record_id) DO UPDATE SET sf_id = EXCLUDED.sf_id, sf_legacy_cid = EXCLUDED.sf_legacy_cid, sf_match = EXCLUDED.sf_match
       WHERE salesforce_sync.sf_id IS NULL`, [stored.id, m.sfId, m.cid ?? stored.id]);
    return 'linked';
  }

  // A mirrored copy: kept equal to the Contact. Another Contact with the same email that changed later takes over.
  const changes = changedCandidateColumns(stored, m);
  if (changes.email && await queryOne(`SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2`, [m.email, stored.id])) return 'email_taken';
  if (changes.phone_number && !(await phoneFree(m.phoneNumber, stored.id))) delete changes.phone_number;
  if ((stored.cv_file_url || '') !== (cvKey ?? '')) changes.cv_file_url = cvKey ?? '';
  const cvJson = cv ? JSON.stringify(cv) : null;
  if (JSON.stringify(stored.legacy_cv ?? null) !== JSON.stringify(cv ?? null)) changes.legacy_cv = cvJson;
  const match = ambiguous || (stored.legacy_sf_id && stored.legacy_sf_id !== m.sfId) ? 'ambiguous' : stored.legacy_match ?? null;
  if (match !== (stored.legacy_match ?? null)) changes.legacy_match = match;
  const sfChanged = stored.legacy_sf_id !== m.sfId || (stored.legacy_cid ?? null) !== m.cid;
  if (!Object.keys(changes).length && !sfChanged) {
    await asLegacyWriter((q) => q(`UPDATE users SET legacy_synced_at = now() WHERE id = $1 AND legacy_state = 'mirror'`, [stored.id]));
    return 'unchanged';
  }
  const cols = Object.keys(changes);
  const sets = cols.map((c, i) => `${c} = $${i + 2}${c === 'legacy_cv' ? '::jsonb' : ''}`);
  await asLegacyWriter((q) => q(
    `UPDATE users SET ${[...sets, `legacy_sf_id = $${cols.length + 2}`, `legacy_cid = $${cols.length + 3}`, 'legacy_synced_at = now()'].join(', ')}
       ${cols.length ? ', updated_at = now()' : ''} WHERE id = $1 AND legacy_state = 'mirror'`,
    [stored.id, ...Object.values(changes), m.sfId, m.cid]));
  if (sfChanged || 'cv_file_url' in changes) await seedSync(stored.id, m, cvKey, 'mirror');
  return cols.length ? 'updated' : 'unchanged';
};

let running = false;

/** One read of the existing site's candidates (`full`: every Contact; otherwise only those changed since the last run). */
export const runCandidatesMirror = async (opts: { full?: boolean; actor?: string } = {}):
  Promise<{ ran: boolean; reason?: string; counts?: CandidateCounts; truncated?: boolean }> => {
  if (!candidatesMirrorActive()) return { ran: false, reason: candidatesMode() !== 'mirror' ? 'mode_not_mirror' : 'salesforce_disabled' };
  if (running) return { ran: false, reason: 'already_running' };
  running = true;
  const state = await readState();
  const counts = emptyCounts();
  const skip = (code: string) => { counts.skipped[code] = (counts.skipped[code] ?? 0) + 1; };
  state.lastRunAt = new Date().toISOString();
  try {
    const s = appConfig.salesforce;
    const describe = await describeObject('Contact');
    const has = (f: string) => describe.fields.some((x) => x.name === f);
    const fields = ['Id', 'LastModifiedDate', ...LEGACY_CONTACT_FIELDS.filter(has)];
    const accounts = s.legacyCandidateAccounts.map((a) => `'${soqlId(a)}'`).join(',');
    if (!accounts) throw Object.assign(new Error('no accounts'), { code: 'no_accounts' });
    // Read-only SOQL: the existing site's candidates (they carry ID_cambium__c) in the candidates' Accounts; this
    // site's own Contacts (Beta) are left out.
    const where = [`AccountId IN (${accounts})`, `ID_cambium__c != null`];
    if (has(s.betaField)) where.push(`${s.betaField} = false`);
    const full = !!opts.full || (state.fullReadVersion ?? 0) < CANDIDATES_FULL_READ_VERSION
      || !state.lastFullAt || Date.now() - Date.parse(state.lastFullAt) > FULL_EVERY_MS;
    const since = full ? null : state.watermark;
    if (since) where.push(`LastModifiedDate > ${soqlDateTime(since)}`);
    const { records, truncated } = await sfQueryAll<Record<string, unknown>>(
      `SELECT ${fields.join(', ')} FROM Contact WHERE ${where.join(' AND ')} ORDER BY LastModifiedDate ASC`, 50_000);
    counts.read = records.length;

    const ctx = await context();
    const mapped: MirroredCandidate[] = [];
    for (const c of records) {
      const r = contactToCandidate(c, ctx);
      if (r.ok) mapped.push(r.candidate); else skip(r.code);
    }
    // Contacts this site made itself (a candidate's, an employer's, a quick applicant's) are never copied.
    const ours = mapped.length ? new Set((await query<{ id: string }>(
      `SELECT sf_id AS id FROM salesforce_sync WHERE sf_id = ANY($1::text[]) AND kind IN ('candidate','employer') AND sf_match IS DISTINCT FROM 'mirror' AND sf_legacy_cid IS NULL
       UNION SELECT sf_contact_id FROM salesforce_sync WHERE sf_contact_id = ANY($1::text[]) AND kind = 'guest_application'`,
      [mapped.map((m) => m.sfId)])).map((r) => String(r.id))) : new Set<string>();
    // Several Contacts with one email: the one changed last is used (records come oldest first), marked for a look.
    const byEmail = new Map<string, number>();
    for (const m of mapped) byEmail.set(m.email, (byEmail.get(m.email) ?? 0) + 1);
    const cvs = await readCvs(mapped.filter((m) => !ours.has(m.sfId)).map((m) => m.sfId));

    for (const m of mapped) {
      if (ours.has(m.sfId)) { skip('made_here'); continue; }
      try {
        const outcome = await storeCandidate(m, cvs.get(m.sfId), (byEmail.get(m.email) ?? 0) > 1);
        if (outcome === 'created' || outcome === 'created_phone_shared') { counts.created++; if (outcome !== 'created') skip('phone_shared'); }
        else if (outcome === 'updated' || outcome === 'unchanged' || outcome === 'linked') counts[outcome]++;
        else skip(outcome);
      } catch (e) {
        skip('db_error');
        console.error(`[legacy-candidates] contact ${m.sfId}: ${safeErrorText(e)}`);
      }
    }

    state.watermark = truncated ? state.watermark : nextWatermark(state.watermark, records.map((c) => String(c.LastModifiedDate ?? '')));
    if (full && !truncated) { state.fullReadVersion = CANDIDATES_FULL_READ_VERSION; state.lastFullAt = new Date().toISOString(); }
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    state.last = counts;
    await saveState(state);
    if (counts.created || counts.updated || counts.linked || opts.actor) {
      await writeAudit(opts.actor ?? LEGACY_CANDIDATES_ACTOR, 'legacy_candidates.mirrored', 'salesforce', {
        full, read: counts.read, created: counts.created, updated: counts.updated, linked: counts.linked, skipped: counts.skipped,
      });
    }
    if (counts.created || counts.updated || counts.linked || Object.keys(counts.skipped).some((k) => k !== 'quick_application')) {
      const skipped = Object.entries(counts.skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      console.log(`[legacy-candidates] read ${counts.read}: ${counts.created} added, ${counts.updated} updated, ${counts.linked} linked; skipped: ${skipped}`);
    }
    return { ran: true, counts, truncated };
  } catch (e) {
    state.lastError = (e as any)?.code === 'no_accounts' ? 'no_accounts' : salesforceErrorCode(e);
    state.last = counts;
    await saveState(state).catch(() => undefined);
    console.error(`[legacy-candidates] mirror run failed: ${state.lastError}`);
    return { ran: false, reason: state.lastError ?? 'error', counts };
  } finally {
    running = false;
  }
};

/** At boot: owned = the cutover (mirror → owned); mirror = the rollback (owned → mirror). off changes nothing. */
export const applyLegacyCandidatesMode = async (): Promise<{ moved: number; to: string | null }> => {
  const mode = candidatesMode();
  if (mode === 'off') return { moved: 0, to: null };
  const [from, to] = mode === 'owned' ? ['mirror', 'owned'] : ['owned', 'mirror'];
  const r = await asLegacyWriter((q) => q(`UPDATE users SET legacy_state = $2 WHERE legacy_state = $1`, [from, to]));
  const moved = r.rowCount ?? 0;
  if (moved) {
    await writeAudit(LEGACY_CANDIDATES_ACTOR, to === 'owned' ? 'legacy_candidates.taken_over' : 'legacy_candidates.returned_to_mirror', 'users', { count: moved, mode });
    console.log(`[legacy-candidates] ${moved} candidates of the existing site are now ${to === 'owned' ? 'ordinary candidates here' : 'read-only again'}`);
  }
  return { moved, to };
};

/** At boot: the periodic read (mirror mode with Salesforce on only), shortly after the jobs mirror. Hourly by default:
 *  before the cutover candidates only view here, so a change made on the existing site may take that long to show. */
export const startCandidatesMirror = () => {
  if (!candidatesMirrorActive()) return;
  const every = appConfig.salesforce.legacyCandidatesMirrorMinutes * 60_000;
  setTimeout(() => { void runCandidatesMirror(); }, 45_000).unref?.();
  setInterval(() => { void runCandidatesMirror(); }, every).unref();
};

/** For admins: counts and codes only. */
export const legacyCandidatesSummary = async () => {
  const c = await queryOne<{ mirror: number; owned: number; linked: number; with_cv: number; ambiguous: number }>(
    `SELECT COUNT(*) FILTER (WHERE legacy_state = 'mirror')::int AS mirror,
            COUNT(*) FILTER (WHERE legacy_state = 'owned')::int AS owned,
            COUNT(*) FILTER (WHERE legacy_state IS NULL AND legacy_sf_id IS NOT NULL)::int AS linked,
            COUNT(*) FILTER (WHERE legacy_state IS NOT NULL AND cv_file_url LIKE 'sf:%')::int AS with_cv,
            COUNT(*) FILTER (WHERE legacy_match = 'ambiguous')::int AS ambiguous
       FROM users WHERE 'user' = ANY(roles) AND legacy_sf_id IS NOT NULL`);
  return {
    mode: candidatesMode(),
    mirrorActive: candidatesMirrorActive(),
    accounts: appConfig.salesforce.legacyCandidateAccounts.length,
    everyMinutes: appConfig.salesforce.legacyCandidatesMirrorMinutes,
    state: await readState(),
    candidates: {
      mirror: c?.mirror ?? 0, owned: c?.owned ?? 0, linkedAccounts: c?.linked ?? 0, withCv: c?.with_cv ?? 0,
      ambiguousEmail: c?.ambiguous ?? 0,
    },
  };
};
