// Shared helpers for the e2e suites that need rows a fresh LOCAL database doesn't have.
// Local databases only: every function refuses a DATABASE_URL that isn't on this machine.
//
// - ensureImportedJob(): an active job "imported from the existing site" (jobs.imported_from_live), the kind production
//   no longer has (2026-11-purge-imported-jobs) but the read-only rules still cover. Seeds one when none exists.
// - skip(reason) / isSkip(e) / summary(results): a check that can't run here is reported as SKIP with the reason —
//   never counted as passed.
//
// `node test/local-setup.mjs` seeds a whole fresh database (cities, skills, the snapshot's jobs, the dev staff).

const LOCAL_DB = /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;

export const assertLocalDatabase = (url = process.env.DATABASE_URL) => {
  if (!url || !LOCAL_DB.test(url)) throw new Error('local database only: DATABASE_URL must point at localhost / 127.0.0.1');
  return url;
};

/** A check that can't run on this setup. The suites' check() reports it as SKIP (not passed, not failed). */
export class SkipCheck extends Error {
  constructor(reason) { super(reason); this.name = 'SkipCheck'; this.skip = true; }
}
export const skip = (reason) => new SkipCheck(reason);
export const isSkip = (e) => !!e?.skip;

/** The summary line: skipped checks are not counted as passed, and the line says how many were skipped. */
export const summary = (results, word = 'passed') => {
  const pass = results.filter((r) => r[0] === 'PASS').length;
  const skipped = results.filter((r) => r[0] === 'SKIP').length;
  return `${pass}/${results.length - skipped} ${word}${skipped ? ` — ${skipped} SKIPPED (see the SKIP lines)` : ''}`;
};

const SEEDED_IMPORTED_ID = 'e2e0000000000000000000a1'; // 24 hex, like the existing site's ids
const SEEDED_CITY = 9001;

/**
 * Makes sure the local DB has an ACTIVE, published job imported from the existing site and returns its id; null when
 * no DATABASE_URL is set (the caller then looks for one through the API and skips when there is none).
 * Only inserts (imported jobs are read-only after that: db.ts jobs_imported_readonly).
 */
export const ensureImportedJob = async ({ url = process.env.DATABASE_URL } = {}) => {
  if (!url) return null;
  assertLocalDatabase(url);
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const found = (await db.query(
      `SELECT id FROM jobs WHERE imported_from_live AND deleted_at IS NULL AND status = 'Active' AND publish_date <= now()
       ORDER BY publish_date DESC LIMIT 1`)).rows[0];
    if (found) return found.id;
    let city = (await db.query(`SELECT city_symbol FROM locations ORDER BY city_symbol LIMIT 1`)).rows[0]?.city_symbol;
    if (city == null) {
      city = SEEDED_CITY;
      await db.query(`INSERT INTO locations (city_symbol, city, district, identifier) VALUES ($1, 'עיר בדיקה', '', $1)
                      ON CONFLICT (city_symbol) DO NOTHING`, [city]);
    }
    await db.query(
      `INSERT INTO jobs (id, title, company_name, publish_date, city_symbol, description, status, imported_from_live)
       VALUES ($1, 'משרה מהאתר הקיים (בדיקה)', 'חברת בדיקה', now() - interval '1 day', $2, '<p>משרה לבדיקה בלבד</p>', 'Active', true)
       ON CONFLICT (id) DO NOTHING`, [SEEDED_IMPORTED_ID, city]);
    return SEEDED_IMPORTED_ID;
  } finally {
    await db.end();
  }
};
