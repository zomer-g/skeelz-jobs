// Seeds a FRESH LOCAL database with what every e2e suite expects, from files in the repo only (no network):
//   - the schema (migrate);
//   - cities and skills (the job lists join `locations`; skill ids are 24 hex) and the board's jobs as jobs imported from
//     the existing site (read-only here), all from seed/live-snapshot.json — `importFromLive` with LIVE_PUBLIC_API unset;
//   - the dev admin and content manager of server/.env.example (bootstrapAdmin; the server also does it at boot).
//
//   cd server && npx tsc && DATABASE_URL=postgresql://postgres@127.0.0.1:5437/postgres node test/local-setup.mjs
//
// The local database: `npm run db:local` (pglite on 5437; --max-connections=20, fewer drops ECONNRESET under the suites).
// test/run-local.mjs does all of it per suite (fresh DB, this seed, a fresh server). Local databases only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalDatabase } from './helpers/localDb.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The values of server/.env.example (dev / test values only), as an env object. */
export const exampleEnv = () => {
  const env = {};
  for (const line of fs.readFileSync(path.join(SERVER_DIR, '.env.example'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
};

export const seedLocalDatabase = (databaseUrl = process.env.DATABASE_URL, { quiet = false } = {}) => {
  assertLocalDatabase(databaseUrl);
  for (const f of ['importFromLive.js', 'bootstrapAdmin.js']) {
    if (!fs.existsSync(path.join(SERVER_DIR, 'dist', 'scripts', f))) throw new Error(`dist/scripts/${f} missing: run \`npx tsc\` first`);
  }
  // LIVE_PUBLIC_API is cleared on purpose: the snapshot in the repo, never the live site.
  const env = { ...process.env, ...exampleEnv(), DATABASE_URL: databaseUrl, LIVE_PUBLIC_API: '' };
  for (const script of ['importFromLive.js', 'bootstrapAdmin.js']) {
    const r = spawnSync(process.execPath, [path.join('dist', 'scripts', script)], { cwd: SERVER_DIR, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-400)}`);
    if (!quiet) process.stdout.write(r.stdout.split('\n').filter((l) => l.startsWith('[import]') || l.startsWith('[bootstrap')).join('\n') + '\n');
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    seedLocalDatabase();
    console.log('local-setup: done');
  } catch (e) {
    console.error(`local-setup: ${e.message}`);
    process.exitCode = 1;
  }
}
