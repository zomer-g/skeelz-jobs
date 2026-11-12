/* ============================================================================
 *  SANDBOX ONLY: replace this database with a fresh copy of prod's data.
 *
 *  The sandbox's data is static: deploys and restarts keep it. A copy is taken
 *  only (a) at the first boot of an empty sandbox (launch.sh, --if-empty), and
 *  (b) when an admin asks for it (POST /api/internal/sandbox-refresh, the
 *  button in the sandbox admin header). Prod is only read (one GET).
 *
 *    SANDBOX=true                 required, or the script refuses to run
 *    SANDBOX_SOURCE_URL           prod's address, e.g. https://<prod-app>.xhostd.app
 *    SANDBOX_SOURCE_TOKEN         secret, equal to prod's SANDBOX_EXPORT_TOKEN
 *
 *  The sandbox's own admin (ADMIN_EMAIL) and their sessions survive a refresh.
 *  If prod cannot be read, nothing changes; an empty sandbox is seeded from the
 *  public live board instead (importFromLive).
 *
 *  Usage:  node dist/scripts/importFromProd.js [--if-empty]
 * ========================================================================== */
import { pathToFileURL } from 'url';
import { migrate, pool, query } from '../config/db.js';
import { importFromLive } from './importFromLive.js';

// Insert order (parents first). tokens and cv_uploads are emptied, not copied.
const TABLES = ['locations', 'skills', 'jobs', 'users', 'job_applications'] as const;

const hostOf = (u?: string) => { try { return new URL(u || '').host; } catch { return ''; } };

export const importFromProd = async (opts: { ifEmpty?: boolean } = {}) => {
  if (process.env.SANDBOX !== 'true') throw new Error('refusing to run: SANDBOX is not "true" (this script wipes the database)');
  if (opts.ifEmpty) {
    await migrate();
    const [{ n }] = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM jobs`);
    if (n > 0) {
      console.log(`[sandbox] data kept (${n} jobs); copy from prod on demand with the admin "refresh" button`);
      return null;
    }
  }
  const source = (process.env.SANDBOX_SOURCE_URL || '').replace(/\/+$/, '');
  const token = process.env.SANDBOX_SOURCE_TOKEN || '';
  if (!source || !token) throw new Error('SANDBOX_SOURCE_URL and SANDBOX_SOURCE_TOKEN are required');
  if (hostOf(source) && hostOf(source) === hostOf(process.env.CLIENT_BASE_URL)) {
    throw new Error('refusing to run: SANDBOX_SOURCE_URL is this channel itself');
  }

  const res = await fetch(`${source}/api/internal/export`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'skeelz-jobs-sandbox-import' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GET ${source}/api/internal/export -> ${res.status}`);
  const data = (await res.json()) as Record<string, any[]>;
  for (const t of TABLES) if (!Array.isArray(data[t])) throw new Error(`export has no "${t}" array`);

  await migrate();
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Keep the sandbox's own admin (and their login) across the copy.
    const keptUsers = adminEmail
      ? (await client.query(`SELECT * FROM users WHERE lower(email) = $1`, [adminEmail])).rows : [];
    const keptTokens = keptUsers.length
      ? (await client.query(`SELECT * FROM tokens WHERE user_id = ANY($1)`, [keptUsers.map((u) => u.id)])).rows : [];
    await client.query(`TRUNCATE job_applications, tokens, cv_uploads, users, jobs, skills, locations`);
    for (const t of TABLES) {
      if (!data[t].length) continue;
      // json_populate_recordset maps each object's keys onto the table's columns and types.
      await client.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json)`, [JSON.stringify(data[t])]);
    }
    for (const [t, rows] of [['users', keptUsers], ['tokens', keptTokens]] as const) {
      if (!rows.length) continue;
      await client.query(`INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await migrate(); // job number sequence past the copied numbers
  const counts = Object.fromEntries(TABLES.map((t) => [t, data[t].length]));
  console.log(`[sandbox] copied from ${source} (exported ${data.exportedAt}): ` +
    TABLES.map((t) => `${counts[t]} ${t}`).join(', '));
  return { exportedAt: data.exportedAt as unknown as string, counts };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  importFromProd({ ifEmpty: process.argv.includes('--if-empty') })
    .catch(async (e) => {
      console.error('[sandbox] import from prod failed:', e.message);
      if (process.env.SANDBOX !== 'true') { process.exitCode = 1; return; }
      const [{ n }] = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM jobs`).catch(() => [{ n: 0 }]);
      if (n > 0) { console.log(`[sandbox] keeping the ${n} jobs already here`); return; }
      console.log('[sandbox] empty: seeding from the public live board');
      await importFromLive().catch((e2) => { console.error('[sandbox] seed failed:', e2.message); process.exitCode = 1; });
    })
    .finally(() => pool.end());
}
