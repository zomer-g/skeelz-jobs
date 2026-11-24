// Runs the e2e suites one by one, each on a FRESH local database and a FRESH local server, and prints a pass table.
// Local only: the database is a throw-away pglite under the OS temp folder, the server listens on localhost, every
// integration stays off or points at the suites' own mocks. Nothing is sent anywhere.
//
//   cd server && npx tsc && node test/run-local.mjs                 (every suite of CLAUDE.md "Tests")
//   cd server && npx tsc && node test/run-local.mjs e2e e2e-mail    (some of them)
//
// Per suite: pglite on DB_PORT (5460) → test/local-setup.mjs (snapshot cities / skills / imported jobs, dev staff) →
// `node dist/index.js` on PORT (3100) with server/.env.example + the suite's extra values below → the suite with BASE and
// DATABASE_URL → server and database stopped, the folder removed. Self-contained suites (they start their own database
// and/or server) only get the parts they need. Refuses to start when something already answers on the ports.
// Logs of a failed suite stay in the printed folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleEnv, seedLocalDatabase } from './local-setup.mjs';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RUN_LOCAL_PORT || 3100);
const DB_PORT = Number(process.env.RUN_LOCAL_DB_PORT || 5460);
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = `postgresql://postgres@127.0.0.1:${DB_PORT}/postgres`;
const SUITE_TIMEOUT_MS = Number(process.env.RUN_LOCAL_TIMEOUT_MS || 10 * 60_000);

// Test values only (each is also written in its suite's header). Never a real secret.
const INTERNAL_API_SECRET = 'e2e-internal-api-secret-local-only-0123456789';
const SALESFORCE_MOCK = {
  ENABLE_SALESFORCE: 'true', SALESFORCE_LOGIN_URL: 'http://127.0.0.1:3198', SALESFORCE_CLIENT_ID: 'e2e-sf-client',
  SALESFORCE_CLIENT_SECRET: 'e2e-sf-secret-not-real', SALESFORCE_CONTACTS_ACCOUNT_ID: '001000000000AAAAAA',
  SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID: '001000000000BBBBBB', SALESFORCE_CASE_ACCOUNT_ID: '001000000000CCCCCC',
  SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID: '012000000000OrgAAA', SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID: '012000000000AppAAA',
  SALESFORCE_CASE_RECORD_TYPE_ID: '012000000000JobAAA',
};

/** db: fresh database + seed; server: our server; serverEnv / suiteEnv: extra values. */
const SUITES = {
  'e2e': { db: true, server: true },
  'e2e-auth': { db: true, server: true },
  'e2e-apply-modes': { db: true, server: true },
  'e2e-submissions': { db: true, server: true },
  'e2e-coordinator': { db: true, server: true },
  'e2e-jobs-admin': { db: true, server: true },
  'e2e-threshold': { db: true, server: true },
  'e2e-employers': { db: true, server: true },
  'e2e-employer-isolation': { db: true, server: true },
  'e2e-employer-applicants': { db: true, server: true },
  'e2e-signup-fields': { db: true, server: true },
  'e2e-settings': { db: true, server: true },
  'e2e-multi-role': { db: true, server: true },
  'e2e-microsoft-sso': { db: true, server: true },
  'e2e-activity-log': { db: true, server: true },
  'e2e-email-signin': { db: true, server: true },
  'e2e-internal-api': { db: true, server: true, serverEnv: { INTERNAL_API_SECRET }, suiteEnv: { INTERNAL_API_SECRET } },
  'e2e-mail': { db: true, server: true, serverEnv: {
    APPLICATION_NOTIFICATION_EMAIL: 'team@example.test', MAIL_WORKER_MS: '2000',
    RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1' } },
  'e2e-salesforce': { db: true, server: true, serverEnv: SALESFORCE_MOCK },
  'e2e-salesforce-fields': { db: true, server: true, serverEnv: SALESFORCE_MOCK },
  'e2e-marketing': { db: true, server: true, serverEnv: { RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1' },
    suiteEnv: { RESEND_WEBHOOK_SECRET: 'whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1' } },
  'live-security': { db: true, server: true },
  'e2e-consent': { db: true, server: false },          // starts its own server (3105) on our database
  'e2e-legacy-candidates': { db: false, server: false }, // own database, mocks and server
  'e2e-cutover': { db: false, server: false },           // own database, mocks and server
};

const portInUse = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(500); }
  throw new Error(`${what}: not ready after ${ms / 1000}s`);
};
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([done, sleep(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const runOne = async (name, spec, work) => {
  const dir = fs.mkdtempSync(path.join(work, `${name}-`));
  const log = (what) => fs.openSync(path.join(dir, `${what}.log`), 'w');
  let pg, server;
  try {
    for (const p of [spec.db && DB_PORT, spec.server && PORT].filter(Boolean)) {
      if (await portInUse(p)) throw new Error(`port ${p} is already in use: stop what runs there first`);
    }
    if (spec.db) {
      pg = spawn(process.execPath, [path.join('node_modules', '@electric-sql', 'pglite-socket', 'dist', 'scripts', 'server.js'),
        `--db=${path.join(dir, 'pg')}`, `--port=${DB_PORT}`, '--max-connections=20'], { cwd: SERVER_DIR, stdio: ['ignore', log('pglite'), log('pglite')] });
      await waitFor(() => portInUse(DB_PORT), 30_000, 'pglite');
      seedLocalDatabase(DATABASE_URL, { quiet: true });
    }
    const env = { ...process.env, ...exampleEnv(), ...(spec.db ? { DATABASE_URL } : {}) };
    if (!spec.db) delete env.DATABASE_URL; // self-contained suites make their own
    if (spec.server) {
      server = spawn(process.execPath, ['dist/index.js'], { cwd: SERVER_DIR, env: { ...env, PORT: String(PORT), ...spec.serverEnv },
        stdio: ['ignore', log('server'), log('server')] });
      await waitFor(async () => (await fetch(`${BASE}/api/jobs/active`)).ok, 60_000, 'server');
    }
    const out = path.join(dir, 'suite.log');
    const suite = spawn(process.execPath, [path.join('test', `${name}.mjs`)], { cwd: SERVER_DIR,
      env: { ...env, ...(spec.server ? { BASE } : {}), ...spec.suiteEnv }, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(out, 'a')] });
    const timer = setTimeout(() => suite.kill(), SUITE_TIMEOUT_MS);
    const code = await new Promise((r) => suite.once('exit', (c) => r(c)));
    clearTimeout(timer);
    const text = fs.readFileSync(out, 'utf8');
    const line = text.split('\n').reverse().find((l) => /\d+\/\d+ (checks )?passed/.test(l))?.trim() ?? '(no summary line)';
    const fails = text.split('\n').filter((l) => /^(FAIL|✗|✖)/.test(l.trim())).map((l) => l.trim().slice(0, 160));
    const skips = text.split('\n').filter((l) => /^SKIP/.test(l.trim())).map((l) => l.trim().slice(0, 160));
    return { name, ok: code === 0, line, fails, skips, dir };
  } catch (e) {
    return { name, ok: false, line: `setup error: ${e.message}`, fails: [], skips: [], dir };
  } finally {
    await stop(server);
    await stop(pg);
  }
};

const asked = process.argv.slice(2);
const unknown = asked.filter((n) => !SUITES[n]);
if (unknown.length) { console.error(`unknown suite(s): ${unknown.join(', ')}. Known: ${Object.keys(SUITES).join(', ')}`); process.exit(2); }
if (!fs.existsSync(path.join(SERVER_DIR, 'dist', 'index.js'))) { console.error('dist/ missing: run `npx tsc` first'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skeelz-e2e-'));
const results = [];
for (const name of asked.length ? asked : Object.keys(SUITES)) {
  process.stdout.write(`${name} … `);
  const r = await runOne(name, SUITES[name], work);
  console.log(`${r.ok ? 'ok' : 'FAILED'}  ${r.line}`);
  for (const l of [...r.fails, ...r.skips]) console.log(`    ${l}`);
  if (r.ok) fs.rmSync(r.dir, { recursive: true, force: true });
  else console.log(`    logs: ${r.dir}`);
  results.push(r);
}
console.log('\n| suite | result |\n|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.ok ? '' : 'FAILED: '}${r.line.replace(/\|/g, '/')} |`);
if (results.every((r) => r.ok)) fs.rmSync(work, { recursive: true, force: true });
process.exit(results.every((r) => r.ok) ? 0 : 1);
