// The cutover from the existing site, end to end, against a MOCK Salesforce and a MOCK of the existing site's public
// API — never a real org, never the real site. Self-contained: it starts its own FRESH local database (pglite), the
// mocks and the server (from dist/: run `npx tsc` first), and restarts the server between the modes:
//   cd server && npx tsc && node test/e2e-cutover.mjs
// Ports (override with env): DB 5448, server 3111, Salesforce 3196, existing site 3187, sign-in provider 3195.
//
// 1. LEGACY_JOBS_MODE=mirror, Beta on: the existing site's jobs read from Salesforce (+ its public board): same _id and
//    number, status and fields, read-only here (409 + DB trigger), never pushed, nothing written to Salesforce by the
//    mirror; incremental reads; a change in Salesforce → the copy follows; off the board → closed; on the public API.
//    Candidates: an existing Contact found by email is adopted (no second Contact, never Beta, only empty fields
//    filled, its ID_cambium__c kept and named by the application Case); several → the newest + "ambiguous"; another
//    Account / this site's own guest Contact → never adopted; quick applications never adopt. Job numbers from 3001,
//    the job link /job/<id>, the cutover report (counts and ids only), the connection check (edit access).
// 2. LEGACY_JOBS_MODE=owned: every mirrored job is managed here (logged), the mirror stops, an edit updates the SAME
//    Position Case (never a new one, never Beta, record type / Account untouched); a job with no Case gets one; a Case
//    the integration user may not edit → a clear code.
// 3. SALESFORCE_BETA_MARK=false: no Beta written; the check says so.
// 4. Back to mirror (the rollback): logged, read-only again, the copies follow Salesforce.
// Also: nothing personal in the server's console output.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');
const DB_PORT = Number(process.env.CUTOVER_DB_PORT || 5448);
const PORT = Number(process.env.CUTOVER_PORT || 3111);
const SF_PORT = Number(process.env.CUTOVER_SF_PORT || 3196);
const LIVE_PORT = Number(process.env.CUTOVER_LIVE_PORT || 3187);
process.env.MOCK_IDP_PORT = process.env.MOCK_IDP_PORT || '3195';
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = `postgresql://postgres@127.0.0.1:${DB_PORT}/postgres`;
const ADMIN_EMAIL = 'admin@example.test';
const CM_EMAIL = 'content@example.test';

const { staffLogin } = await import('./helpers/staffLogin.mjs');
const { signUp } = await import('./helpers/candidate.mjs');
const { startMockSalesforce, MOCK_IDS, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } = await import('./helpers/mockSalesforce.mjs');
const pg = (await import('pg')).default;
const { PDFDocument } = await import('pdf-lib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;

// ---- the existing site's public API (mock): GET only ----
const SKILL_A = '677e68ea063529e50d3e9822';
const SKILL_B = '677e68ea063529e50d3e9826';
const live = {
  locations: [{ citySymbol: 5000, city: 'תל אביב - יפו', district: 'תל אביב', identifier: 5000 },
    { citySymbol: 4000, city: 'חיפה', district: 'חיפה', identifier: 4000 }, { citySymbol: 8600, city: 'רמת גן', district: 'תל אביב', identifier: 8600 }],
  skills: [{ _id: SKILL_A, name: 'עבודה בצוות' }, { _id: SKILL_B, name: 'Excel' }],
  jobs: [],
  hits: 0, writes: 0,
};
const liveServer = http.createServer((req, res) => {
  live.hits++;
  if (req.method !== 'GET') { live.writes++; res.writeHead(405); return res.end(); }
  const body = req.url === '/api/locations' ? { data: live.locations } : req.url === '/api/skills' ? { data: { skills: live.skills } }
    : req.url === '/api/jobs/active' ? { data: { jobs: live.jobs } } : null;
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
});
await new Promise((r) => liveServer.listen(LIVE_PORT, '127.0.0.1', r));

const sf = await startMockSalesforce({ port: SF_PORT, pageSize: 3 });

// ---- a fresh database ----
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeelz-cutover-db-'));
const pgScript = path.join(SERVER_DIR, 'node_modules', '@electric-sql', 'pglite-socket', 'dist', 'scripts', 'server.js');
const dbLog = fs.openSync(path.join(os.tmpdir(), `skeelz-cutover-db-${stamp}.log`), 'w');
const dbProc = spawn(process.execPath, [pgScript, `--db=${dbDir}`, `--port=${DB_PORT}`, '--max-connections=20'], { cwd: SERVER_DIR, stdio: ['ignore', dbLog, dbLog] });
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`${what} did not come up${last ? `: ${last.message}` : ''}`);
};
await waitFor(async () => { const c = new pg.Client({ connectionString: DATABASE_URL }); await c.connect(); await c.end(); return true; }, 90000, 'pglite');
// The suite's own connection. pglite serves several connections over one engine and now and then answers out of
// turn under load: such a protocol hiccup reconnects and retries once (a real SQL error is thrown as it is).
const connectDb = async () => { const c = new pg.Client({ connectionString: DATABASE_URL }); c.on('error', () => undefined); await c.connect(); return c; };
let dbClient = await connectDb();
const HICCUP = /unexpected \w+ message|Connection terminated|ECONNRESET|not queryable/i;
const db = {
  async query(...a) {
    try { return await dbClient.query(...a); }
    catch (e) {
      if (!HICCUP.test(String(e?.message))) throw e;
      try { await dbClient.end(); } catch { /* gone */ }
      dbClient = await connectDb();
      return dbClient.query(...a);
    }
  },
  end: () => dbClient.end(),
};

// ---- the server ----
const logFile = path.join(os.tmpdir(), `skeelz-cutover-server-${stamp}.log`);
const log = fs.createWriteStream(logFile);
const baseEnv = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  PORT: String(PORT), DATABASE_URL, DEV_MODE: 'true', NODE_ENV: 'development',
  ACCESS_TOKEN_SECRET: 'dev-access-secret-change-me-0123456789', REFRESH_TOKEN_SECRET: 'dev-refresh-secret-change-me-0123456789',
  RESET_TOKEN_SECRET: 'dev-reset-secret-change-me-0123456789', CLIENT_BASE_URL: BASE,
  ENABLE_SMOOVE: 'false', SEND_EMAIL_ENABLED: 'false', EMAIL_CODE_SIGNIN_ENABLED: 'true',
  ADMIN_EMAIL, CONTENT_MANAGER_EMAIL: CM_EMAIL, CONTENT_MANAGER_INITIAL_PASSWORD: 'dev-content-password-123', ADMIN_INITIAL_PASSWORD: 'dev-admin-password-123',
  SSO_ENABLED: 'true', SSO_ISSUER: `http://127.0.0.1:${process.env.MOCK_IDP_PORT}`, SSO_JWKS_URL: `http://127.0.0.1:${process.env.MOCK_IDP_PORT}/jwks`,
  ENABLE_SALESFORCE: 'true', SALESFORCE_LOGIN_URL: sf.url, SALESFORCE_CLIENT_ID: MOCK_CLIENT_ID, SALESFORCE_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  SALESFORCE_CONTACTS_ACCOUNT_ID: MOCK_IDS.contactsAccount, SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID: MOCK_IDS.applicationsAccount,
  SALESFORCE_CASE_ACCOUNT_ID: MOCK_IDS.jobsAccount, SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID: MOCK_IDS.employerAccountRecordType,
  SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID: MOCK_IDS.applicationsRecordType, SALESFORCE_CASE_RECORD_TYPE_ID: MOCK_IDS.jobsRecordType,
  LEGACY_PUBLIC_API: `http://127.0.0.1:${LIVE_PORT}/api`, LEGACY_JOBS_MIRROR_MINUTES: '60',
};
let server = null;
const startServer = async (extra) => {
  const env = { ...baseEnv, ...extra };
  server = spawn(process.execPath, ['dist/index.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  await waitFor(async () => (await fetch(`${BASE}/api/health-check`)).ok, 60000, 'the server');
};
const stopServer = async () => {
  if (!server) return;
  const p = new Promise((r) => server.once('exit', r));
  server.kill();
  await p;
  server = null;
};

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, p, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + p, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
};
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const where = (object, f) => [...sf.records[object].values()].filter(f);
const synced = (r) => !!r.last_pushed_at && !r.queued && !r.last_error_code;
const syncRow = async (kind, id, until, ms = 15000) => {
  const end = Date.now() + ms;
  let row;
  while (Date.now() < end) {
    row = (await db.query(`SELECT *, queued_at IS NOT NULL AS queued FROM salesforce_sync WHERE kind = $1 AND record_id = $2`, [kind, id])).rows[0];
    if (row && until(row)) return row;
    await sleep(250);
  }
  throw new Error(`${kind} ${id}: sync row never reached the state (last: ${JSON.stringify(row && { sf: row.sf_id, code: row.last_error_code, queued: row.queued })})`);
};
const pdf = async () => { const d = await PDFDocument.create(); d.addPage().drawText('CV'); return Buffer.from(await d.save()); };
const upload = async (client, token, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdf()], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
/** The mirror's "read now"; a run started by the server itself at boot may be going: wait for it. */
const runMirror = async (admin, body = {}) => {
  for (let i = 0; i < 40; i++) {
    const r = await admin.req('POST', '/api/admin/security/salesforce/legacy-jobs/run', body);
    if (!(r.status === 409 && r.json?.code === 'already_running')) return r;
    await sleep(500);
  }
  throw new Error('the mirror stayed busy');
};
/** In mirror mode the server reads once by itself ~30 s after boot. pglite runs every connection in ONE session, so
 *  the suite waits for that read to finish before it touches the database directly (real Postgres isolates them). */
const waitBootRead = async (admin, since) => waitFor(async () => {
  const s = (await admin.req('GET', '/api/admin/security/salesforce/legacy-jobs')).json?.data?.state;
  return !!s?.lastRunAt && new Date(s.lastRunAt) >= since && !!(s.lastOkAt || s.lastError) && new Date(s.lastOkAt ?? s.lastRunAt) >= new Date(s.lastRunAt);
}, 60000, 'the boot read');
const jobRow = async (id) => (await db.query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];

// ---- the existing site's data (in the mock org and on its board) ----
// A job made on this site (takes applications while the existing site's jobs are mirrored).
const NEW_JOB = 'cc00000000000000000000a9';
const PID = { A: 'aa00000000000000000000a1', B: 'aa00000000000000000000b2', C: 'aa00000000000000000000c3', D: 'aa00000000000000000000d4', OWN: 'bb00000000000000000000e5', OTHER: 'aa00000000000000000000f6' };
const position = (pid, fields) => sf.seed('Case', {
  RecordTypeId: MOCK_IDS.jobsRecordType, AccountId: MOCK_IDS.jobsAccount, PID_cambium__c: pid, Beta__c: false, Status: 'New', OwnerId: '005000000000OldAAA',
  company_cambium__c: 'חברה ותיקה', citySymbol_cambium__c: '5000', PLocation_cambium__c: 'תל אביב - יפו', PTime_cambium__c: 'FullTime',
  PSkills_cambium__c: SKILL_A, PFullName_cambium__c: 'איש קשר', PPhone_cambium__c: '035555555', PEmail_cambium__c: `hr-${stamp}@company.example.test`,
  PComments_cambium__c: 'הערה פנימית', PCreatedDate_cambium__c: '2026-11-10T08:00:00.000Z', PModifiedDate_cambium__c: '2026-11-11T08:00:00.000Z',
  isSponserd_cambium__c: false, isMarked_cambium__c: false, isSelfApply_cambium__c: false, ...fields,
});
const sfId = {};
sfId.A = position(PID.A, { Position_cambium__c: 'משרה A', PStatus__c: 'Active', isSponserd_cambium__c: true, PDescription_cambium__c: 'תיאור A',
  PComments_cambium__c: 'שכר כ 10,500 ש&quot;ח' });
sfId.B = position(PID.B, { Position_cambium__c: 'משרה B', PStatus__c: 'Suspended', PLink_cambium__c: 'jobs.skeelz.co.il/job/1777', PDescription_cambium__c: 'שורה 1\nשורה 2', PTime_cambium__c: 'PartialTime;FullTime',
  PSkills_cambium__c: `${SKILL_A},Excel` });
sfId.C = position(PID.C, { Position_cambium__c: 'משרה C ישנה', PStatus__c: null, citySymbol_cambium__c: null, PLocation_cambium__c: 'חיפה', PDescription_cambium__c: '<p>ישן</p>' });
position('1794', { Position_cambium__c: 'מזהה לא תקין', PStatus__c: 'Active' });
sf.seed('Case', { RecordTypeId: MOCK_IDS.jobsRecordType, AccountId: MOCK_IDS.jobsAccount, PID_cambium__c: PID.OWN, Beta__c: true, Position_cambium__c: 'של האתר החדש', PStatus__c: 'Active', citySymbol_cambium__c: '5000' });
sf.seed('Case', { RecordTypeId: MOCK_IDS.jobsRecordType, AccountId: '001000000000ZZZZZZ', PID_cambium__c: PID.OTHER, Beta__c: false, Position_cambium__c: 'חשבון אחר', PStatus__c: 'Active', citySymbol_cambium__c: '5000' });
const HTML_A = '<div class="text-editor-output-container"><p>תיאור <strong>מעוצב</strong></p><ul><li>א</li></ul></div>';
live.jobs = [
  { _id: PID.A, jobId: 1900, title: 'משרה A', description: HTML_A, citySymbol: 5000, companyName: 'חברה ותיקה', jobScope: ['FullTime'], requiredSkills: [SKILL_A],
    status: 'Active', externalLink: 'https://apply.company.example.test/a', uploadBy: 'staff@skeelz.example.test', publishDate: '2026-11-10T08:00:00.000Z' },
  { _id: PID.D, jobId: 1901, title: 'משרה D (רק בלוח)', description: '<p>D</p>', citySymbol: 4000, companyName: 'חברה D', jobScope: ['PartialTime'], requiredSkills: [],
    status: 'Active', publishDate: '2026-11-12T08:00:00.000Z' },
];

const admin = jar(), cm = jar(), anon = jar(), c1 = jar(), c2 = jar(), c3 = jar(), c4 = jar(), c5 = jar(), guest = jar();
const ids = {};
const EM = { c1: `old-${stamp}@example.test`, c2: `twice-${stamp}@example.test`, c3: `other-acct-${stamp}@example.test`, c4: `guest-first-${stamp}@example.test`, c5: `beta-off-${stamp}@example.test` };
const signUpBody = (email) => ({ firstName: 'דנה', lastName: 'חדשה', email, phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z',
  gender: 'female', citySymbol: 5000, skills: [SKILL_A], hasAppliedToJob: false, consent: true });
// Contacts the existing site made (and one in another Account, which is never touched).
sfId.oldC1 = sf.seed('Contact', { AccountId: MOCK_IDS.contactsAccount, Email: EM.c1.toUpperCase(), email_cambium__c: EM.c1, LastName: 'ישנה', FirstName: '',
  Phone: '', ID_cambium__c: '5f00000000000000000000c1', CV_link_cambium__c: 'old/cv.pdf', LastModifiedDate: '2025-01-01T00:00:00.000+0000' });
sfId.twiceOld = sf.seed('Contact', { AccountId: MOCK_IDS.contactsAccount, Email: EM.c2, LastName: 'ישנה 1', ID_cambium__c: '5f00000000000000000000c2', LastModifiedDate: '2024-01-01T00:00:00.000+0000' });
sfId.twiceNew = sf.seed('Contact', { AccountId: MOCK_IDS.contactsAccount, Email: EM.c2, LastName: 'ישנה 2', ID_cambium__c: '5f00000000000000000000c3', LastModifiedDate: '2025-06-01T00:00:00.000+0000' });
sfId.otherAcct = sf.seed('Contact', { AccountId: '001000000000YYYYYY', Email: EM.c3, LastName: 'בחשבון אחר', ID_cambium__c: '5f00000000000000000000c4' });

try {
  // =========================== 1. mirror ===========================
  const bootAt = new Date();
  await startServer({ LEGACY_JOBS_MODE: 'mirror' });
  const boot = spawnSync(process.execPath, ['dist/scripts/bootstrapAdmin.js'], { cwd: SERVER_DIR, env: { ...baseEnv, LEGACY_JOBS_MODE: 'mirror' }, encoding: 'utf-8' });
  if (boot.status !== 0) throw new Error(`bootstrapAdmin failed: ${boot.stderr}`);

  await check('setup: staff sign in; Salesforce on (mock), the mirror active; the state shows the mode', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
    const s = await admin.req('GET', '/api/admin/security/salesforce');
    assert.equal(s.json?.data?.enabled, true, JSON.stringify(s.json?.data?.problems));
    const l = await admin.req('GET', '/api/admin/security/salesforce/legacy-jobs');
    assert.equal(l.status, 200, l.text);
    assert.equal(l.json.data.mode, 'mirror');
    assert.equal(l.json.data.mirrorActive, true);
    await waitBootRead(admin, bootAt);
  });

  await check('only admins see or run the mirror and the cutover report', async () => {
    for (const [m, p] of [['GET', '/api/admin/security/salesforce/legacy-jobs'], ['POST', '/api/admin/security/salesforce/legacy-jobs/run'], ['GET', '/api/admin/security/salesforce/cutover-report']]) {
      // A content manager on an admin route is refused AND signed out (the rule above their role): a throwaway session.
      const probe = jar();
      assert.equal((await staffLogin(probe, CM_EMAIL)).status, 200);
      const a = await anon.req(m, p, m === 'POST' ? {} : undefined);
      const b = await probe.req(m, p, m === 'POST' ? {} : undefined);
      assert.ok([401, 403].includes(a.status) || a.status === 400, `${m} ${p} anon ${a.status}`);
      assert.ok([401, 403].includes(b.status) || b.status === 400, `${m} ${p} content manager ${b.status}`);
    }
  });

  await check('first read: every job of the existing site, same _id, number, status and fields; nothing written to Salesforce or to the site', async () => {
    const writes = sf.seen.writes.length;
    const r = await runMirror(admin, { full: true });
    assert.equal(r.status, 200, r.text);
    const c = r.json.data.counts;
    // The server's own read ~30 s after boot came first: it added A, B, C (from their Cases) and D (from the board alone).
    const bootLog = (await db.query(`SELECT details FROM audit_log WHERE action = 'legacy_jobs.mirrored' AND actor = 'system:legacy-jobs' ORDER BY id LIMIT 1`)).rows[0];
    assert.equal((bootLog?.details?.created ?? 0) + c.created, 5, JSON.stringify({ boot: bootLog?.details, admin: c }));
    assert.equal(c.created + c.unchanged, 4, JSON.stringify(c)); // the full read sees the four Cases again, changes nothing
    assert.equal(c.skipped.bad_pid, 1, JSON.stringify(c));
    assert.equal(sf.seen.writes.length, writes, 'the mirror writes nothing to Salesforce');
    assert.equal(live.writes, 0, 'only GET to the existing site');
    const a = await jobRow(PID.A);
    assert.equal(a.legacy_state, 'mirror');
    assert.equal(a.legacy_sf_id, sfId.A);
    assert.equal(a.job_id, 1900);
    assert.equal(a.status, 'Active');
    assert.equal(a.title, 'משרה A');
    assert.equal(a.is_sponsored, true);
    assert.match(a.description, /<strong>מעוצב<\/strong>/, 'the board\'s formatted description');
    assert.equal(a.external_link, 'https://apply.company.example.test/a');
    assert.equal(a.comments, 'שכר כ 10,500 ש"ח');
    assert.equal(a.upload_by, 'staff@skeelz.example.test');
    assert.deepEqual(a.required_skills, [SKILL_A]);
    const b = await jobRow(PID.B);
    assert.equal(b.status, 'Suspended');
    assert.deepEqual([...b.job_scope].sort(), ['FullTime', 'PartialTime']);
    assert.deepEqual([...b.required_skills].sort(), [SKILL_A, SKILL_B].sort(), 'a skill by name is mapped to its id');
    assert.match(b.description, /שורה 1<br ?\/?>שורה 2/);
    assert.equal(b.job_id, 1777, 'not on the board: the number from the Case\'s link');
    const cc = await jobRow(PID.C);
    assert.ok(cc.job_id >= 3001, `no number anywhere: the next free one (${cc.job_id})`);
    assert.equal(cc.status, 'Closed', 'empty status = closed');
    assert.equal(cc.city_symbol, 4000, 'city by name');
    const d = await jobRow(PID.D);
    assert.equal(d.job_id, 1901);
    assert.equal(d.legacy_sf_id, null);
    assert.equal(await jobRow(PID.OWN), undefined, 'this site\'s own (Beta) Cases are not read');
    assert.equal((await jobRow(PID.OTHER))?.legacy_state, 'mirror', 'a Case moved to another Account (the employer\'s) is read too');
    assert.equal(await jobRow('1794'), undefined);
    const log = (await db.query(`SELECT actor, details FROM audit_log WHERE action = 'legacy_jobs.mirrored' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.actor, ADMIN_EMAIL, 'the admin\'s read is logged as theirs');
    assert.equal(log.details.full, true);
    assert.ok(sf.seen.queries.some((q) => /FROM Case WHERE RecordTypeId = .* AND PID_cambium__c != null AND Beta__c = false/.test(q)), 'the read query');
  });

  await check('the public sees the active ones (board, job page by id, public API by number); not the suspended or closed', async () => {
    const list = await anon.req('GET', '/api/public/v1/jobs?limit=50');
    assert.equal(list.status, 200, list.text);
    const shown = new Set(list.json.data.map((j) => j.id ?? j._id));
    assert.ok(shown.has(PID.A) && shown.has(PID.D), `public: ${[...shown]}`);
    assert.ok(!shown.has(PID.B) && !shown.has(PID.C));
    assert.equal((await anon.req('GET', '/api/public/v1/jobs/1900')).status, 200);
    assert.equal((await anon.req('GET', `/api/public/v1/jobs/${PID.B}`)).status, 404);
  });

  await check('mirrored jobs are read-only here: the screen, the form and the database itself refuse; never queued', async () => {
    assert.equal((await cm.req('PATCH', `/api/admin/jobs/${PID.A}/board`, { status: 'Suspended' })).json?.code, 'job_read_only');
    assert.equal((await cm.req('PATCH', `/api/jobs/${PID.A}`, { title: 'x', status: 'Active' })).status, 409);
    assert.equal((await cm.req('POST', `/api/admin/jobs/${PID.A}/archive`)).status, 409);
    assert.equal((await cm.req('POST', `/api/admin/jobs/${PID.A}/pin`)).status, 409);
    const q = (await db.query(`SELECT 1 FROM salesforce_sync WHERE kind = 'job' AND record_id = ANY($1)`, [[PID.A, PID.B, PID.C, PID.D]])).rows;
    assert.equal(q.length, 0);
  });

  await check('a site-wide apply setting does not touch mirrored jobs (and still saves)', async () => {
    const r = await cm.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
    assert.equal(r.status, 200, r.text);
  });

  await check('a change in Salesforce → the copy follows (status and fields); an unchanged read changes nothing', async () => {
    sf.touch('Case', sfId.A, { PStatus__c: 'Suspended', Position_cambium__c: 'משרה A (עודכנה)', isMarked_cambium__c: true });
    const before = (await jobRow(PID.A)).updated_at;
    let r;
    try {
      r = await runMirror(admin);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.data.counts.updated >= 1, JSON.stringify(r.json.data.counts));
      const a = await jobRow(PID.A);
      assert.equal(a.status, 'Suspended');
      assert.equal(a.title, 'משרה A (עודכנה)');
      assert.equal(a.is_marked, true);
      assert.match(a.description, /מעוצב/, 'the formatted description stays');
      assert.ok(new Date(a.updated_at) > new Date(before), 'the time of the change in Salesforce');
    } finally {
      sf.touch('Case', sfId.A, { PStatus__c: 'Active' });
      r = await runMirror(admin);
    }
    assert.equal((await jobRow(PID.A)).status, 'Active');
    r = await runMirror(admin);
    assert.equal(r.json.data.counts.created + r.json.data.counts.updated, 0, JSON.stringify(r.json.data.counts));
    assert.match(sf.seen.queries.at(-1), /LastModifiedDate > \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ORDER BY LastModifiedDate ASC$/, 'incremental: only what changed since the last read');
  });

  await check('a copy read before its number was known gets the existing site\'s number later', async () => {
    sf.touch('Case', sfId.C, { PLink_cambium__c: 'jobs.skeelz.co.il/job/1555' });
    const r = await runMirror(admin);
    assert.equal(r.status, 200, r.text);
    assert.equal((await jobRow(PID.C)).job_id, 1555);
  });

  await check('a new job on the existing site arrives; a board-only job that left the board is closed', async () => {
    const pidE = 'aa00000000000000000000e7';
    sfId.E = position(pidE, { Position_cambium__c: 'משרה E חדשה', PStatus__c: 'Active', PDescription_cambium__c: 'E' });
    live.jobs = live.jobs.filter((j) => j._id !== PID.D);
    const r = await runMirror(admin);
    assert.equal(r.json.data.counts.created, 1, JSON.stringify(r.json.data.counts));
    assert.equal(r.json.data.counts.closed, 1);
    assert.equal((await jobRow(pidE)).legacy_state, 'mirror');
    assert.equal((await jobRow(PID.D)).status, 'Closed');
    ids.E = pidE;
  });

  await check('job numbers here start above the existing site\'s (3001+); the job link is /job/<id>', async () => {
    const r = await cm.req('POST', '/api/jobs', {
      title: `משרה של האתר החדש ${stamp}`, jobScope: ['FullTime'], companyName: 'חדשה', publishDate: new Date(Date.now() - 1000).toISOString(),
      citySymbol: 5000, description: '<p>חדשה</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [SKILL_A], isSponsored: false, isMarked: false, isSelfApply: false,
    });
    assert.equal(r.status, 200, r.text);
    ids.own = r.json.data.id ?? r.json.data._id;
    assert.ok((await jobRow(ids.own)).job_id > 3000);
    await syncRow('job', ids.own, synced);
    const c = where('Case', (x) => x.PID_cambium__c === ids.own);
    assert.equal(c.length, 1);
    assert.equal(c[0].PLink_cambium__c, `${BASE}/job/${ids.own}`);
    assert.equal(c[0].Beta__c, true);
  });

  await check('a candidate whose email has a Contact of the existing site: that Contact is adopted (no second one, never Beta, only empty fields filled)', async () => {
    const r = await signUp(c1, signUpBody(EM.c1));
    assert.equal(r.status, 200, r.text);
    ids.c1 = String(r.json.data._id);
    const row = await syncRow('candidate', ids.c1, synced);
    assert.equal(row.sf_id, sfId.oldC1);
    assert.equal(row.sf_legacy_cid, '5f00000000000000000000c1');
    assert.equal(row.sf_match, 'email');
    assert.equal(where('Contact', (x) => String(x.Email).toLowerCase() === EM.c1).length, 1, 'no second Contact');
    const old = sf.records.Contact.get(sfId.oldC1);
    assert.equal(old.ID_cambium__c, '5f00000000000000000000c1', 'its key stays');
    assert.equal(old.LastName, 'ישנה', 'not overwritten');
    assert.equal(old.Email, EM.c1.toUpperCase(), 'not overwritten');
    assert.equal(old.FirstName, 'דנה', 'an empty field is filled');
    assert.match(old.Phone, /^05\d{8}$/, 'an empty field is filled');
    assert.equal(old.AccountId, MOCK_IDS.contactsAccount);
    assert.equal(old.Beta__c, undefined, 'never marked Beta');
    const pushed = (await db.query(`SELECT details FROM audit_log WHERE action = 'salesforce.pushed' AND details->>'kind' = 'candidate' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.ok(JSON.stringify(pushed.details).includes(ids.c1), 'strict log names the candidate');
  });

  await check('a mirrored job takes no application (409 job_on_existing_site); one made here does: its Case linked to the adopted Contact, A_CID = its old key', async () => {
    // Owner, 23.11.2026: until the cutover applications to the existing site's jobs are not taken here.
    const jobWrites = () => sf.seen.writes.filter((w) => w.object === 'Case' && [sfId.A].includes(w.id)).length;
    const before = jobWrites();
    const refused = await c1.req('POST', `/api/jobs/apply/${PID.A}`, { cv: { mode: 'profile' } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json?.code, 'job_on_existing_site');
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM job_applications WHERE job_id = $1`, [PID.A])).rows[0].n, 0);
    await db.query(`INSERT INTO jobs (id, title, company_name, publish_date, city_symbol, description, status)
                    VALUES ($1, 'משרה של האתר החדש', 'E2E', now() - interval '1 hour', 5000, '<p>e2e</p>', 'Active')`, [NEW_JOB]);
    const r = await c1.req('POST', `/api/jobs/apply/${NEW_JOB}`, { cv: { mode: 'profile' } });
    assert.equal(r.status, 200, r.text);
    ids.app1 = (await db.query(`SELECT id FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.c1, NEW_JOB])).rows[0].id;
    const row = await syncRow('application', ids.app1, synced);
    const kase = sf.records.Case.get(row.sf_id);
    assert.equal(kase.A_PID_cambium__c, NEW_JOB);
    assert.equal(kase.A_CID_cambium__c, '5f00000000000000000000c1');
    assert.equal(kase.ContactId, sfId.oldC1);
    assert.equal(kase.RecordTypeId, MOCK_IDS.applicationsRecordType);
    assert.equal(jobWrites(), before, 'the mirrored job\'s Case is not written');
    assert.equal(where('Case', (x) => x.PID_cambium__c === PID.A).length, 1, 'still one Position Case');
  });

  await check('several Contacts with that email: the newest is adopted and counted as ambiguous', async () => {
    const r = await signUp(c2, signUpBody(EM.c2));
    assert.equal(r.status, 200, r.text);
    ids.c2 = String(r.json.data._id);
    const row = await syncRow('candidate', ids.c2, synced);
    assert.equal(row.sf_id, sfId.twiceNew);
    assert.equal(row.sf_legacy_cid, '5f00000000000000000000c3');
    assert.equal(row.sf_match, 'email_ambiguous');
  });

  await check('a Contact in another Account is never adopted: a new Contact (Beta) is made', async () => {
    const r = await signUp(c3, signUpBody(EM.c3));
    assert.equal(r.status, 200, r.text);
    ids.c3 = String(r.json.data._id);
    const row = await syncRow('candidate', ids.c3, synced);
    assert.notEqual(row.sf_id, sfId.otherAcct);
    assert.equal(row.sf_legacy_cid, null);
    const mine = sf.records.Contact.get(row.sf_id);
    assert.equal(mine.ID_cambium__c, ids.c3);
    assert.equal(mine.Beta__c, true);
    assert.equal(sf.records.Contact.get(sfId.otherAcct).FirstName, undefined, 'untouched');
  });

  await check('quick applications never adopt (unverified email); this site\'s own guest Contact is never adopted by a later sign-up', async () => {
    const t = crypto.randomUUID();
    assert.equal((await upload(guest, t, 'g.pdf')).status, 200);
    const g = await guest.req('POST', '/api/jobs/guestApply', { consent: true, jobData: { _id: NEW_JOB },
      guestData: { fullName: 'אורחת', email: EM.c1, phoneNumber: phone(), cvFilePath: `${t}/g.pdf` } });
    assert.equal(g.status, 200, g.text);
    const gid = (await db.query(`SELECT id FROM guest_applications WHERE job_id = $1 AND email = lower($2)`, [NEW_JOB, EM.c1])).rows[0].id;
    const row = await syncRow('guest_application', gid, synced);
    assert.notEqual(row.sf_contact_id, sfId.oldC1, 'a new guest Contact');
    assert.equal(sf.records.Contact.get(row.sf_contact_id).ID_cambium__c, gid);
    assert.equal(sf.records.Case.get(row.sf_id).A_PID_cambium__c, NEW_JOB);
    // A guest first, then a sign-up with that email: the guest's Contact is this site's own → a new Contact.
    const t2 = crypto.randomUUID();
    assert.equal((await upload(guest, t2, 'g2.pdf')).status, 200);
    assert.equal((await guest.req('POST', '/api/jobs/guestApply', { consent: true, jobData: { _id: NEW_JOB },
      guestData: { fullName: 'אורח', email: EM.c4, phoneNumber: phone(), cvFilePath: `${t2}/g2.pdf` } })).status, 200);
    const gid4 = (await db.query(`SELECT id FROM guest_applications WHERE email = lower($1)`, [EM.c4])).rows[0].id;
    const g4 = await syncRow('guest_application', gid4, synced);
    const r = await signUp(c4, signUpBody(EM.c4));
    assert.equal(r.status, 200, r.text);
    ids.c4 = String(r.json.data._id);
    const row4 = await syncRow('candidate', ids.c4, synced);
    assert.notEqual(row4.sf_id, g4.sf_contact_id);
    assert.equal(row4.sf_legacy_cid, null);
  });

  await check('cutover report: Position Cases against the jobs here, candidates\' matches; counts and job ids only; logged', async () => {
    const r = await admin.req('GET', '/api/admin/security/salesforce/cutover-report');
    assert.equal(r.status, 200, r.text);
    const d = r.json.data;
    assert.equal(d.jobs.ok, true, JSON.stringify(d.jobs));
    assert.equal(d.jobs.positionCases, 6, JSON.stringify(d.jobs)); // A, B, C, E, the other Account's + the bad id (not the Beta one)
    assert.equal(d.jobs.notHere.count, 0);
    assert.equal(d.jobs.activeThereNotHere.count, 0);
    assert.deepEqual(d.jobs.hereWithoutCase.ids, [PID.D]);
    assert.equal(d.candidates.adoptedByEmail, 2);
    assert.equal(d.candidates.ambiguousEmail, 1);
    assert.equal(d.legacy.jobs.mirror, 6);
    for (const e of Object.values(EM)) assert.ok(!r.text.includes(e), 'no email in the report');
    assert.ok(!r.text.includes('hr-'), 'no job contact in the report');
    assert.ok((await db.query(`SELECT 1 FROM audit_log WHERE action = 'salesforce.cutover_report'`)).rows.length);
  });

  await check('connection check: the existing site\'s Cases not editable → a warning while mirroring (not a failure)', async () => {
    for (const k of ['A', 'B', 'C', 'E']) sf.denyEdit(sfId[k]);
    const r = await admin.req('POST', '/api/admin/security/salesforce/check', {});
    const item = r.json.data.items.find((i) => i.id === 'legacy_edit_access');
    assert.ok(item, JSON.stringify(r.json.data.items.map((i) => i.id)));
    assert.equal(item.ok, true);
    assert.equal(item.warn, true);
    assert.equal(item.code, 'legacy_case_not_editable');
    for (const k of ['A', 'B', 'C', 'E']) sf.allowEdit(sfId[k]);
    const ok = (await admin.req('POST', '/api/admin/security/salesforce/check', {})).json.data.items.find((i) => i.id === 'legacy_edit_access');
    assert.equal(ok.ok, true);
    assert.equal(ok.code, undefined);
  });

  // =========================== 2. owned (the cutover) ===========================
  await stopServer();

  // With the server stopped only this connection talks to the database (pglite runs every connection in ONE session,
  // so while the server runs a statement here could land inside one of its mirror transactions).
  await check('the database itself refuses to change, unmark or delete a mirrored job (trigger jobs_legacy_guard)', async () => {
    const before = (await jobRow(PID.A)).title;
    // Plain statements (no parameters; the ids are fixed hex constants): after an error on a PARAMETERIZED query
    // pglite-socket answers the next one out of turn. Job C has no applications (A's delete would be refused earlier,
    // by jobs_keep_applications).
    await assert.rejects(db.query(`UPDATE jobs SET title = 'x' WHERE id = '${PID.A}'`), /read-only here/);
    await assert.rejects(db.query(`UPDATE jobs SET legacy_state = NULL WHERE id = '${PID.A}'`), /only the existing-site mirror/);
    await assert.rejects(db.query(`DELETE FROM jobs WHERE id = '${PID.C}'`), /never deleted/);
    assert.equal((await jobRow(PID.A)).title, before, 'unchanged');
    assert.equal((await jobRow(PID.A)).legacy_state, 'mirror');
    assert.ok(await jobRow(PID.C), 'still there');
  });
  await startServer({ LEGACY_JOBS_MODE: 'owned' });

  await check('cutover at boot: every mirrored job is managed here now; logged; the mirror stops', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
    const states = (await db.query(`SELECT legacy_state, COUNT(*)::int AS n FROM jobs WHERE legacy_state IS NOT NULL GROUP BY 1`)).rows;
    assert.deepEqual(states, [{ legacy_state: 'owned', n: 6 }]);
    const log = (await db.query(`SELECT actor, details FROM audit_log WHERE action = 'legacy_jobs.taken_over' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.actor, 'system:legacy-jobs');
    assert.equal(log.details.count, 6);
    const r = await admin.req('POST', '/api/admin/security/salesforce/legacy-jobs/run', {});
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'legacy_mirror_off');
  });

  await check('an edit here updates the SAME Position Case: no new Case, no Beta, record type / Account / owner / status untouched', async () => {
    const before = { ...sf.records.Case.get(sfId.A) };
    const r = await cm.req('PATCH', `/api/jobs/${PID.A}`, { title: 'משרה A — מנוהלת כאן', status: 'Active' });
    assert.equal(r.status, 200, r.text);
    const row = await syncRow('job', PID.A, synced);
    assert.equal(row.sf_id, sfId.A);
    const after = sf.records.Case.get(sfId.A);
    assert.equal(after.Position_cambium__c, 'משרה A — מנוהלת כאן');
    assert.equal(after.Beta__c, false, 'not marked Beta');
    assert.equal(after.RecordTypeId, before.RecordTypeId);
    assert.equal(after.AccountId, before.AccountId);
    assert.equal(after.OwnerId, before.OwnerId);
    assert.equal(after.Status, before.Status);
    assert.equal(after.PLink_cambium__c, `${BASE}/job/${PID.A}`);
    assert.equal(where('Case', (x) => x.PID_cambium__c === PID.A).length, 1, 'still one Case');
    assert.ok(!sf.seen.writes.some((w) => w.method === 'POST' && w.object === 'Case' && sf.records.Case.get(w.id)?.PID_cambium__c === PID.A));
  });

  await check('board settings too (pin is site-only; status goes to the Case); applications keep going to the same job', async () => {
    assert.equal((await cm.req('POST', `/api/admin/jobs/${PID.B}/pin`)).status, 200);
    assert.equal((await cm.req('PATCH', `/api/admin/jobs/${PID.B}/board`, { status: 'Active' })).status, 200);
    await syncRow('job', PID.B, (x) => synced(x) && x.sf_id === sfId.B);
    assert.equal(sf.records.Case.get(sfId.B).PStatus__c, 'Active');
    const r = await c3.req('POST', `/api/jobs/apply/${PID.B}`, { cv: { mode: 'profile' } });
    assert.equal(r.status, 200, r.text);
    const app = (await db.query(`SELECT id FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.c3, PID.B])).rows[0].id;
    const row = await syncRow('application', app, synced);
    assert.equal(sf.records.Case.get(row.sf_id).A_PID_cambium__c, PID.B);
  });

  await check('a job of the existing site with no Case gets one (looked up first)', async () => {
    assert.equal((await cm.req('PATCH', `/api/admin/jobs/${PID.D}/board`, { status: 'Active' })).status, 200);
    const row = await syncRow('job', PID.D, synced);
    const c = where('Case', (x) => x.PID_cambium__c === PID.D);
    assert.equal(c.length, 1);
    assert.equal(c[0].Id, row.sf_id);
  });

  await check('a Case the integration user may not edit → a clear, permanent code (nothing duplicated)', async () => {
    sf.denyEdit(sfId.E);
    assert.equal((await cm.req('PATCH', `/api/jobs/${ids.E}`, { title: 'E v2', status: 'Active' })).status, 200);
    const row = await syncRow('job', ids.E, (x) => !!x.last_error_code);
    assert.match(row.last_error_code, /INSUFFICIENT_ACCESS/);
    assert.equal(row.queued, false, 'stops: a fix in Salesforce, then retry');
    assert.equal(where('Case', (x) => x.PID_cambium__c === ids.E).length, 1);
    sf.allowEdit(sfId.E);
    const ch = (await admin.req('POST', '/api/admin/security/salesforce/check', {})).json.data.items.find((i) => i.id === 'legacy_edit_access');
    assert.equal(ch.ok, true);
  });

  await check('owned + edit access denied → the connection check fails (owned needs it)', async () => {
    for (const k of ['A', 'B', 'C', 'E']) sf.denyEdit(sfId[k]);
    const ch = (await admin.req('POST', '/api/admin/security/salesforce/check', {})).json.data.items.find((i) => i.id === 'legacy_edit_access');
    for (const k of ['A', 'B', 'C', 'E']) sf.allowEdit(sfId[k]);
    assert.equal(ch.ok, false);
    assert.equal(ch.code, 'legacy_case_not_editable');
  });

  // =========================== 3. Beta off ===========================
  await stopServer();
  await startServer({ LEGACY_JOBS_MODE: 'owned', SALESFORCE_BETA_MARK: 'false' });

  await check('SALESFORCE_BETA_MARK=false: a new Contact has no Beta; the check says the mark is off', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    const r = await signUp(c5, signUpBody(EM.c5));
    assert.equal(r.status, 200, r.text);
    const row = await syncRow('candidate', String(r.json.data._id), synced);
    assert.equal('Beta__c' in sf.records.Contact.get(row.sf_id), false);
    const ch = await admin.req('POST', '/api/admin/security/salesforce/check', {});
    assert.ok(ch.json.data.items.find((i) => i.id === 'beta_off')?.ok);
    assert.ok(!ch.json.data.items.some((i) => i.id === 'beta_Contact'));
  });

  // =========================== 4. back to mirror (rollback) ===========================
  await stopServer();
  const rollbackAt = new Date();
  await startServer({ LEGACY_JOBS_MODE: 'mirror' });

  await check('rollback: back to mirror at boot (logged), read-only again, the copies follow Salesforce', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
    await waitBootRead(admin, rollbackAt);
    const log = (await db.query(`SELECT details FROM audit_log WHERE action = 'legacy_jobs.returned_to_mirror' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log?.details?.count, 6);
    assert.equal((await cm.req('PATCH', `/api/admin/jobs/${PID.A}/board`, { status: 'Suspended' })).json?.code, 'job_read_only');
    sf.touch('Case', sfId.A, { Position_cambium__c: 'משרה A — שוב מהאתר הקיים' });
    const r = await runMirror(admin);
    assert.equal(r.status, 200, r.text);
    assert.equal((await jobRow(PID.A)).title, 'משרה A — שוב מהאתר הקיים');
  });

  await check('nothing personal in the server\'s console output', async () => {
    await sleep(500);
    const out = fs.readFileSync(logFile, 'utf-8');
    for (const e of [...Object.values(EM), `hr-${stamp}@company.example.test`]) assert.ok(!out.toLowerCase().includes(e.toLowerCase()), `log has ${e}`);
    assert.ok(!/איש קשר|035555555/.test(out));
  });

  await check('nothing was deleted in Salesforce', async () => {
    assert.equal(sf.seen.deletes, 0);
  });
} catch (e) {
  results.push(['FAIL', 'suite', e.stack || e.message]);
} finally {
  await stopServer().catch(() => undefined);
  await db.end().catch(() => undefined);
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(dbProc.pid), '/t', '/f'], { stdio: 'ignore' });
  else dbProc.kill();
  await sf.close();
  liveServer.close();
  log.end();
}

for (const [s, n, m] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${n}${m ? `\n    ${m}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` — server log: ${logFile}` : ''}`);
process.exit(failed ? 1 : 0);
