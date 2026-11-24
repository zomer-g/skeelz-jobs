/* ============================================================================
 *  One-time copy of the PUBLIC data of the live board into this database.
 *
 *  Source: the live site's public, unauthenticated read endpoints
 *    GET {LIVE_PUBLIC_API}/locations, /skills, /jobs/active
 *  Only HTTP GET is used. No candidates, applications or CVs are copied (they
 *  are not public, and they already live in Salesforce).
 *
 *  Ids are kept: job _id (so /job/<id> links match the live site), job number
 *  (Salesforce links), skill ids and city symbols. The jobs are read-only here
 *  (imported_from_live): only jobs created on this platform can be changed.
 *
 *  Usage:  node dist/scripts/importFromLive.js [--if-empty]
 * ========================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { migrate, pool, query } from '../config/db.js';
import { sanitizeJobHtml } from '../utils/sanitize.js';
import { isObjectId } from '../utils/ids.js';

// No address is built in. With LIVE_PUBLIC_API unset (the default), the
// snapshot of the public board that ships with the app
// (seed/live-snapshot.json) is used.
const BASE = (process.env.LIVE_PUBLIC_API || '').replace(/\/+$/, '');
const SNAPSHOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'live-snapshot.json');
const SNAPSHOT_KEYS: Record<string, string> = { '/locations': 'locations', '/skills': 'skills', '/jobs/active': 'jobs' };
let usedSnapshot = false;

const get = async (p: string) => {
  if (!BASE) {
    usedSnapshot = true;
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'))[SNAPSHOT_KEYS[p]];
  }
  try {
    const res = await fetch(`${BASE}${p}`, { headers: { 'User-Agent': 'skeelz-jobs-xhostd-import', Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
    return (await res.json()) as any;
  } catch (e) {
    if (!fs.existsSync(SNAPSHOT)) throw e;
    if (!usedSnapshot) console.warn(`[import] live fetch failed (${(e as Error).message}); using ${path.basename(SNAPSHOT)}`);
    usedSnapshot = true;
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8'))[SNAPSHOT_KEYS[p]];
  }
};

const SCOPES = new Set(['FullTime', 'PartialTime']);
const STATUSES = new Set(['Active', 'Suspended', 'Closed']);

export const importFromLive = async (opts: { ifEmpty?: boolean } = {}) => {
  await migrate();
  if (opts.ifEmpty) {
    const [{ n }] = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM jobs`);
    if (n > 0) {
      console.log(`[import] skipped: ${n} jobs already in the database`);
      return;
    }
  }

  const locations: any[] = (await get('/locations')).data ?? [];
  let nLoc = 0;
  for (const l of locations) {
    const citySymbol = Number(l.citySymbol);
    if (!Number.isFinite(citySymbol) || !l.city) continue;
    await query(
      `INSERT INTO locations (city_symbol, city, district, identifier) VALUES ($1,$2,$3,$4)
       ON CONFLICT (city_symbol) DO UPDATE SET city = EXCLUDED.city, district = EXCLUDED.district, identifier = EXCLUDED.identifier`,
      [citySymbol, String(l.city), String(l.district ?? ''), Number(l.identifier ?? citySymbol)]
    );
    nLoc++;
  }

  const skillsBody = await get('/skills');
  const skills: any[] = skillsBody?.data?.skills ?? skillsBody?.data ?? [];
  let nSkill = 0;
  for (const s of skills) {
    if (!isObjectId(s._id) || !s.name) continue;
    await query(`INSERT INTO skills (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, [s._id, String(s.name)]);
    nSkill++;
  }

  const jobs: any[] = (await get('/jobs/active')).data?.jobs ?? [];
  let nJob = 0;
  for (const j of jobs) {
    if (!isObjectId(j._id) || !j.title || !Number.isFinite(Number(j.citySymbol))) continue;
    const jobNumber = Number(j.jobId);
    await query(
      `INSERT INTO jobs (id, job_id, title, job_scope, company_name, publish_date, city_symbol, description,
                         contact_person_name, contact_person_phone, contact_person_email, external_link, upload_by,
                         status, required_skills, is_sponsored, is_marked, is_self_apply, guest_mode_override, created_at, updated_at,
                         imported_from_live)
       VALUES ($1, COALESCE($2, nextval('jobs_job_id_seq')), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               CASE WHEN $18 THEN 'self' END, COALESCE($19, now()), COALESCE($20, now()), true)
       -- Imported jobs are read-only on this platform (db.ts jobs_imported_readonly): a second run adds, never changes.
       ON CONFLICT (id) DO NOTHING`,
      [
        j._id,
        Number.isFinite(jobNumber) && jobNumber > 0 ? jobNumber : null,
        String(j.title),
        (Array.isArray(j.jobScope) ? j.jobScope : []).filter((s: string) => SCOPES.has(s)),
        String(j.companyName ?? ''),
        j.publishDate ? new Date(j.publishDate) : new Date(),
        Number(j.citySymbol),
        sanitizeJobHtml(String(j.description ?? '')),
        j.contactPersonName ?? null,
        j.contactPersonPhone ?? null,
        j.contactPersonEmail ?? null,
        j.externalLink ?? null,
        j.uploadBy ?? null,
        STATUSES.has(j.status) ? j.status : 'Active',
        (Array.isArray(j.requiredSkills) ? j.requiredSkills : []).filter(isObjectId),
        !!j.isSponsored,
        !!j.isMarked,
        !!j.isSelfApply,
        j.createdAt ? new Date(j.createdAt) : null,
        j.updatedAt ? new Date(j.updatedAt) : null,
      ]
    );
    nJob++;
  }
  await migrate(); // moves the job number sequence past the imported numbers
  console.log(`[import] done: ${nLoc} locations, ${nSkill} skills, ${nJob} active jobs from ${usedSnapshot ? 'snapshot' : BASE}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importFromLive({ ifEmpty: process.argv.includes('--if-empty') })
    .catch((e) => { console.error('[import] failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
