// The existing site's candidates (owner, 20.11.2026), end to end, against a MOCK Salesforce — never a real org.
// Self-contained: its own FRESH local database (pglite), the mock org, a mock of the existing site's public API (cities
// and skills only) and the server (from dist/: run `npx tsc` first), restarted between the modes:
//   cd server && npx tsc && node test/e2e-legacy-candidates.mjs
// Ports (override with env): DB 5449, server 3112, Salesforce 3194, existing site 3186, sign-in provider 3193.
//
// 1. LEGACY_CANDIDATES_MODE=mirror: registered candidates of the configured Accounts (the candidates' and the Retrain
//    Account) are copied — same id as their ID_cambium__c, this site's formats; quick applicants, other Accounts and this
//    site's own (Beta) Contacts are not; nothing is written to Salesforce. Several Contacts with one email → the newest,
//    marked. The candidate signs in with the email and only VIEWS their details (409 candidate_read_only on every
//    change); marketing consent stays changeable. They apply to this site's jobs (their own Contact on the Case, the CV
//    linked, the copy unchanged) but not to the existing site's (409 job_on_existing_site; nothing claimed or recorded). The CV is not copied: opened from
//    Salesforce on demand, by the candidate and by staff (strict log, limits), never uploaded again. Staff see them in
//    the candidates list and can't edit them. A change in Salesforce → the copy follows. An account made here with the
//    same email is linked (empty fields filled) and stays editable. The DB refuses edits and records a deletion.
// 2. LEGACY_CANDIDATES_MODE=owned (the cutover): logged; editable; a change goes to the SAME Contact in full (never a
//    new Contact, never Beta, ID_cambium__c and the Account kept); applying works and the Case names the old key; the
//    CV is linked to the Case, not uploaded again; the mirror refuses to run.
// 3. Back to mirror (the rollback): read-only again; what they changed is kept.
// Also: nothing personal in the server's console output; nothing deleted in Salesforce.
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
const DB_PORT = Number(process.env.CANDS_DB_PORT || 5449);
const PORT = Number(process.env.CANDS_PORT || 3112);
const SF_PORT = Number(process.env.CANDS_SF_PORT || 3194);
const LIVE_PORT = Number(process.env.CANDS_LIVE_PORT || 3186);
process.env.MOCK_IDP_PORT = process.env.MOCK_IDP_PORT || '3193';
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = `postgresql://postgres@127.0.0.1:${DB_PORT}/postgres`;
const ADMIN_EMAIL = 'admin@example.test';
const CM_EMAIL = 'content@example.test';
const RETRAIN = '001000000000RRRRRR';

const { staffLogin } = await import('./helpers/staffLogin.mjs');
const { candidateLogin, signUp } = await import('./helpers/candidate.mjs');
const { startMockSalesforce, MOCK_IDS, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET } = await import('./helpers/mockSalesforce.mjs');
const pg = (await import('pg')).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');

// ---- the existing site's public API (mock, GET only): cities and skills for the job copy ----
const SKILL_A = '677e68ea063529e50d3e9822';
const SKILL_B = '677e68ea063529e50d3e9826';
const PID = 'aa00000000000000000000a1'; // a job of the existing site (mirrored): takes no applications here
// Jobs created on this site (owner, 23.11.2026): they take applications from every candidate, a mirrored one included.
const NEW1 = 'bb00000000000000000000b1', NEW2 = 'bb00000000000000000000b2';
const live = {
  locations: [{ citySymbol: 5000, city: 'תל אביב - יפו', district: 'תל אביב', identifier: 5000 }, { citySymbol: 4000, city: 'חיפה', district: 'חיפה', identifier: 4000 }],
  skills: [{ _id: SKILL_A, name: 'עבודה בצוות' }, { _id: SKILL_B, name: 'Excel' }],
};
const liveServer = http.createServer((req, res) => {
  const body = req.method !== 'GET' ? null : req.url === '/api/locations' ? { data: live.locations } : req.url === '/api/skills' ? { data: { skills: live.skills } }
    : req.url === '/api/jobs/active' ? { data: { jobs: [] } } : null;
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? {}));
});
await new Promise((r) => liveServer.listen(LIVE_PORT, '127.0.0.1', r));
const sf = await startMockSalesforce({ port: SF_PORT, pageSize: 3 });

// ---- a fresh database ----
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeelz-cands-db-'));
const pgScript = path.join(SERVER_DIR, 'node_modules', '@electric-sql', 'pglite-socket', 'dist', 'scripts', 'server.js');
const dbLog = fs.openSync(path.join(os.tmpdir(), `skeelz-cands-db-${stamp}.log`), 'w');
const dbProc = spawn(process.execPath, [pgScript, `--db=${dbDir}`, `--port=${DB_PORT}`, '--max-connections=20'], { cwd: SERVER_DIR, stdio: ['ignore', dbLog, dbLog] });
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { last = e; } await sleep(300); }
  throw new Error(`${what} did not come up${last ? `: ${last.message}` : ''}`);
};
await waitFor(async () => { const c = new pg.Client({ connectionString: DATABASE_URL }); await c.connect(); await c.end(); return true; }, 90000, 'pglite');
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
const logFile = path.join(os.tmpdir(), `skeelz-cands-server-${stamp}.log`);
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
  LEGACY_PUBLIC_API: `http://127.0.0.1:${LIVE_PORT}/api`, LEGACY_JOBS_MIRROR_MINUTES: '60', LEGACY_JOBS_MODE: 'mirror',
  LEGACY_CANDIDATE_ACCOUNTS: `${MOCK_IDS.contactsAccount},${RETRAIN}`,
};
let server = null;
const startServer = async (extra) => {
  server = spawn(process.execPath, ['dist/index.js'], { cwd: SERVER_DIR, env: { ...baseEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    async req(method, p, body) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf-8');
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, buf, headers: res.headers };
    },
  };
};
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const where = (object, f) => [...sf.records[object].values()].filter(f);
const synced = (r) => !!r.last_pushed_at && !r.queued && !r.last_error_code;
const syncRow = async (kind, id, until, ms = 20000) => {
  const end = Date.now() + ms;
  let row;
  while (Date.now() < end) {
    row = (await db.query(`SELECT *, queued_at IS NOT NULL AS queued FROM salesforce_sync WHERE kind = $1 AND record_id = $2`, [kind, id])).rows[0];
    if (row && until(row)) return row;
    await sleep(250);
  }
  throw new Error(`${kind} ${id}: sync row never reached the state (last: ${JSON.stringify(row && { sf: row.sf_id, code: row.last_error_code, queued: row.queued, pushed: row.last_pushed_at })})`);
};
const run = async (admin, kind, body = {}) => {
  for (let i = 0; i < 60; i++) {
    const r = await admin.req('POST', `/api/admin/security/salesforce/legacy-${kind}/run`, body);
    if (!(r.status === 409 && r.json?.code === 'already_running')) return r;
    await sleep(500);
  }
  throw new Error('the mirror stayed busy');
};
/** pglite runs every connection in ONE session: the suite waits for the server's own boot reads before it reads the DB. */
const waitBootReads = async (admin, since, kinds) => {
  for (const k of kinds) {
    await waitFor(async () => {
      const s = (await admin.req('GET', `/api/admin/security/salesforce/legacy-${k}`)).json?.data?.state;
      return !!s?.lastRunAt && new Date(s.lastRunAt) >= since && !!(s.lastOkAt || s.lastError) && new Date(s.lastOkAt ?? s.lastRunAt) >= new Date(s.lastRunAt);
    }, 90000, `the boot read (${k})`);
  }
};
const userRow = async (id) => (await db.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];
const userByEmail = async (e) => (await db.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [e])).rows[0];

// ---- the existing site's data in the mock org ----
const EM = {
  dana: `dana-${stamp}@example.test`, noa: `noa-${stamp}@example.test`, quick: `quick-${stamp}@example.test`, other: `other-${stamp}@example.test`,
  twice: `twice-${stamp}@example.test`, here: `here-${stamp}@example.test`, beta: `beta-${stamp}@example.test`,
};
const CID = { dana: '5f00000000000000000000d1', twiceOld: '5f00000000000000000000d2', twiceNew: '5f00000000000000000000d3', here: '5f00000000000000000000d4' };
const PHONE = { dana: `05${digits(8)}`, noa: `05${digits(8)}` };
const sfId = {};
sfId.job = sf.seed('Case', {
  RecordTypeId: MOCK_IDS.jobsRecordType, AccountId: MOCK_IDS.jobsAccount, PID_cambium__c: PID, Beta__c: false, OwnerId: '005000000000OldAAA',
  Position_cambium__c: 'משרה קיימת', PStatus__c: 'Active', company_cambium__c: 'חברה', citySymbol_cambium__c: '5000', PLocation_cambium__c: 'תל אביב - יפו',
  PTime_cambium__c: 'FullTime', PDescription_cambium__c: 'תיאור', PLink_cambium__c: 'jobs.skeelz.co.il/job/1900',
});
const contact = (fields) => sf.seed('Contact', { Beta__c: false, LastModifiedDate: '2025-01-01T00:00:00.000+0000', ...fields });
sfId.dana = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: CID.dana, LastName: 'לוי', Email: EM.dana.toUpperCase(), email_cambium__c: EM.dana,
  firstName_cambium__c: 'דנה', lastName_cambium__c: 'לוי', phoneNumber_cambium__c: `${PHONE.dana.slice(0, 3)}-${PHONE.dana.slice(3)}`,
  dateOfBirth_cambium__c: '1990-05-01', gender_cambium__c: 'female', citySymbol_cambium__c: '4000', skills_cambium__c: `${SKILL_A},${SKILL_B}`,
  CV_link_cambium__c: 'https://old-bucket.example.test/cv.pdf' });
sfId.noa = contact({ AccountId: RETRAIN, ID_cambium__c: 'retrain-noa-1', FirstName: 'נועה', LastName: 'כהן', Email: EM.noa, MobilePhone: `+972 ${PHONE.noa.slice(1)}`, MailingCity: 'חיפה' });
sfId.quick = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: '5f00000000000000000000e1', LastName: 'מהירה', email_cambium__c: EM.quick, firstName_cambium__c: 'הגשה' });
sfId.other = contact({ AccountId: '001000000000YYYYYY', ID_cambium__c: '5f00000000000000000000e2', LastName: 'אחר', Email: EM.other, gender_cambium__c: 'male', dateOfBirth_cambium__c: '1980-01-01' });
sfId.beta = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: '5f00000000000000000000e3', LastName: 'בטא', Email: EM.beta, Beta__c: true, gender_cambium__c: 'male', dateOfBirth_cambium__c: '1980-01-01' });
sfId.twiceOld = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: CID.twiceOld, LastName: 'ישן', email_cambium__c: EM.twice, gender_cambium__c: 'male', dateOfBirth_cambium__c: '1985-01-01', LastModifiedDate: '2024-01-01T00:00:00.000+0000' });
sfId.twiceNew = contact({ AccountId: RETRAIN, ID_cambium__c: CID.twiceNew, LastName: 'חדש', Email: EM.twice, LastModifiedDate: '2025-06-01T00:00:00.000+0000' });
sfId.here = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: CID.here, LastName: 'קיים', email_cambium__c: EM.here, gender_cambium__c: 'male',
  dateOfBirth_cambium__c: '1970-03-03', citySymbol_cambium__c: '4000', skills_cambium__c: SKILL_B });
const CV_BYTES = Buffer.from(`%PDF-1.4 the existing site's CV ${stamp}`);
const cvFile = sf.seedFile(sfId.dana, { title: 'קורות חיים דנה', ext: 'pdf', bytes: CV_BYTES });
sf.seedFile(sfId.dana, { title: 'תמונה', ext: 'png', bytes: Buffer.from('png') });

const admin = jar(), cm = jar(), anon = jar(), dana = jar(), here = jar(), noa = jar();
const ids = {};

try {
  // =========================== 1. mirror ===========================
  const bootAt = new Date();
  await startServer({ LEGACY_CANDIDATES_MODE: 'mirror' });
  const boot = spawnSync(process.execPath, ['dist/scripts/bootstrapAdmin.js'], { cwd: SERVER_DIR, env: { ...baseEnv, LEGACY_CANDIDATES_MODE: 'mirror' }, encoding: 'utf-8' });
  if (boot.status !== 0) throw new Error(`bootstrapAdmin failed: ${boot.stderr}`);
  // A candidate who already signed up here with the email of an existing Contact (before the mirror reached them).
  await check('setup: staff sign in, the mirrors active; an account made here earlier', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
    await waitBootReads(admin, bootAt, ['jobs', 'candidates']);
    for (const id of [NEW1, NEW2]) {
      await db.query(`INSERT INTO jobs (id, title, company_name, publish_date, city_symbol, description, status)
                      VALUES ($1, 'משרה של האתר החדש', 'E2E', now() - interval '1 hour', 5000, '<p>e2e</p>', 'Active')`, [id]);
    }
    const l = await admin.req('GET', '/api/admin/security/salesforce/legacy-candidates');
    assert.equal(l.status, 200, l.text);
    assert.equal(l.json.data.mode, 'mirror');
    assert.equal(l.json.data.mirrorActive, true);
    assert.equal(l.json.data.accounts, 2);
    for (const [m, p] of [['GET', '/api/admin/security/salesforce/legacy-candidates'], ['POST', '/api/admin/security/salesforce/legacy-candidates/run']]) {
      const probe = jar();
      assert.equal((await staffLogin(probe, CM_EMAIL)).status, 200);
      const pr = await probe.req(m, p, m === 'POST' ? {} : undefined);
      assert.ok([400, 401, 403].includes(pr.status) && !pr.json?.data, `${m} ${p}: content manager refused (${pr.status})`);
      assert.ok([400, 401, 403].includes((await anon.req(m, p, m === 'POST' ? {} : undefined)).status), `${m} ${p}: anonymous refused`);
    }
  });

  await check('first read: registered candidates of both Accounts copied, read-only, in this site\'s formats; nothing written to Salesforce', async () => {
    const writes = sf.seen.writes.length;
    const r = await run(admin, 'candidates', { full: true });
    assert.equal(r.status, 200, r.text);
    const d = await userByEmail(EM.dana);
    assert.ok(d, 'dana copied');
    ids.dana = d.id;
    assert.equal(d.id, CID.dana, 'the same id as the existing site\'s');
    assert.equal(d.legacy_state, 'mirror');
    assert.equal(d.legacy_sf_id, sfId.dana);
    assert.equal(d.legacy_cid, CID.dana);
    assert.equal(d.first_name, 'דנה');
    assert.equal(d.phone_number, PHONE.dana);
    assert.equal(new Date(d.date_of_birth).toISOString().slice(0, 10), '1990-05-01');
    assert.equal(d.gender, 'female');
    assert.equal(d.city_symbol, 4000);
    assert.deepEqual([...d.skills].sort(), [SKILL_A, SKILL_B].sort());
    assert.equal(d.cv_file_url, `sf:${cvFile.versionId}`, 'a pointer to the Contact\'s newest pdf, not a copy');
    assert.equal(d.terms_version, null, 'no consent invented');
    const n = await userByEmail(EM.noa);
    assert.ok(n, 'the Retrain candidate is copied');
    ids.noa = n.id;
    assert.equal(n.phone_number, PHONE.noa);
    assert.equal(n.city_symbol, 4000, 'city by name');
    assert.equal(n.legacy_state, 'mirror');
    assert.equal(await userByEmail(EM.quick), undefined, 'quick applicant not copied');
    assert.equal(await userByEmail(EM.other), undefined, 'another Account not copied');
    assert.equal(await userByEmail(EM.beta), undefined, 'this site\'s own (Beta) Contact not copied');
    assert.equal(sf.seen.writes.length, writes, 'nothing written to Salesforce');
    assert.equal(sf.seen.fileReads, 0, 'no file read while copying');
    const sync = (await db.query(`SELECT * FROM salesforce_sync WHERE kind = 'candidate' AND record_id = $1`, [ids.dana])).rows[0];
    assert.equal(sync.sf_id, sfId.dana);
    assert.equal(sync.sf_match, 'mirror');
    assert.equal(sync.last_pushed_at, null);
    assert.equal(sync.queued_at, null, 'not queued');
  });

  await check('several Contacts with one email: the one changed last is used, marked for a look', async () => {
    const t = await userByEmail(EM.twice);
    assert.equal(t.legacy_sf_id, sfId.twiceNew);
    assert.equal(t.last_name, 'חדש');
    assert.equal(t.legacy_match, 'ambiguous');
  });

  await check('the candidate signs in with the same email and sees their details, read-only', async () => {
    const s = await candidateLogin(dana, EM.dana);
    assert.equal(s.status, 200, s.text);
    const me = await dana.req('GET', '/api/users/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.data.readOnly, true);
    assert.equal(me.json.data.profileIncomplete, false, 'never asked to complete what they can\'t change');
    assert.equal(me.json.data.user.firstName, 'דנה');
    assert.equal(me.json.data.user.email, EM.dana);
  });

  await check('every change is refused (409 candidate_read_only); applying to the existing-site job too (409 job_on_existing_site): nothing claimed or recorded', async () => {
    const before = await userRow(ids.dana);
    for (const [m, p, b] of [['PATCH', '/api/users/me', { firstName: 'שונה' }], ['DELETE', '/api/users/me/cv']]) {
      const r = await dana.req(m, p, b);
      assert.equal(r.status, 409, `${m} ${p}: ${r.status} ${r.text}`);
      assert.equal(r.json?.code, 'candidate_read_only');
      assert.match(r.json?.message ?? '', /לצפות/);
    }
    const legacyJob = await anon.req('GET', `/api/jobs/${PID}`);
    assert.equal(legacyJob.json?.data?.onExistingSite, true, 'the job page marks it as an existing-site job');
    assert.equal((await anon.req('GET', `/api/jobs/${NEW1}`)).json?.data?.onExistingSite, false);
    const r = await dana.req('POST', `/api/jobs/apply/${PID}`, { cv: { mode: 'profile' }, consent: true, marketing: false });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json?.code, 'job_on_existing_site');
    const g = await anon.req('POST', '/api/jobs/guestApply', { jobData: { _id: PID }, consent: true,
      guestData: { fullName: 'אורח', email: `g-${stamp}@example.test`, phoneNumber: '0507777777' } });
    assert.equal(g.status, 409, g.text);
    assert.equal(g.json?.code, 'job_on_existing_site');
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM job_applications WHERE user_id = $1`, [ids.dana])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM guest_applications WHERE job_id = $1`, [PID])).rows[0].n, 0);
    const after = await userRow(ids.dana);
    assert.equal(after.first_name, before.first_name);
    assert.equal(after.terms_version, null, 'no consent recorded by the refused application');
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM consent_records WHERE subject_id = $1`, [ids.dana])).rows[0].n, 0);
  });

  await check('marketing consent can still be given or withdrawn (recorded)', async () => {
    const r = await dana.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: false });
    assert.equal(r.status, 200, r.text);
    assert.equal((await userRow(ids.dana)).marketing_consent, false);
  });

  await check('first sign-in: the consent step (terms never accepted here) is stored on the copy, which stays a copy', async () => {
    const me = await dana.req('GET', '/api/users/me');
    assert.equal(me.json.data.consent.termsCurrent, false, 'a copy has not accepted the terms here: the sign-in step asks');
    const before = await userRow(ids.dana);
    assert.equal((await dana.req('PUT', '/api/users/me/terms', {})).json?.code, 'terms_required');
    // They said no in the personal area, so the step shows the marketing box too (owner, 27.11.2026); left unticked.
    assert.equal(me.json.data.consent.marketingAgreed, false);
    const r = await dana.req('PUT', '/api/users/me/terms', { consent: true, marketingConsent: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.consent.termsCurrent, true);
    assert.equal(r.json.data.consent.marketing, false, 'an unticked box keeps their earlier answer (personal area)');
    assert.equal(r.json.data.readOnly, true);
    const after = await userRow(ids.dana);
    assert.equal(after.legacy_state, 'mirror');
    for (const c of ['first_name', 'email', 'phone_number', 'cv_file_url', 'marketing_consent']) assert.deepEqual(after[c], before[c], `${c} unchanged`);
    const rec = (await db.query(`SELECT source, marketing FROM consent_records WHERE subject_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [ids.dana])).rows[0];
    assert.deepEqual({ s: rec?.source, m: rec?.marketing }, { s: 'first_signin', m: null });
  });

  await check('personal area: the marketing switch works for a copy too (join again after leaving)', async () => {
    const on = await dana.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.data.consent.marketing, true);
    assert.equal((await userRow(ids.dana)).marketing_consent, true);
    assert.equal((await userRow(ids.dana)).legacy_state, 'mirror');
    const off = await dana.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: false });
    assert.equal(off.json?.data?.consent?.marketing, false, off.text);
  });

  await check('the CV stays in Salesforce: the candidate sees and opens it; read from there, never uploaded', async () => {
    const info = await dana.req('GET', '/api/users/me/cv');
    assert.equal(info.status, 200, info.text);
    assert.equal(info.json.data.cv.fileName, 'קורות חיים דנה.pdf');
    const reads = sf.seen.fileReads;
    const f = await dana.req('GET', '/api/users/me/cv/file');
    assert.equal(f.status, 200, f.text);
    assert.equal(f.headers.get('content-type'), 'application/pdf');
    assert.ok(f.buf.equals(CV_BYTES), 'the bytes of the Contact\'s file');
    assert.equal(sf.seen.fileReads, reads + 1);
    assert.equal(where('ContentVersion', () => true).length, 2, 'no file added to Salesforce');
  });

  await check('a job created on this site: the copied candidate applies (their Contact on the Case, the CV linked, the copy unchanged)', async () => {
    const before = await userRow(ids.dana);
    // Replacing the profile CV is a change of their details: refused before any upload is claimed.
    const rp = await dana.req('POST', `/api/jobs/apply/${NEW1}`, { cv: { mode: 'replaceProfile', cvFilePath: 'cvs/none.pdf' }, consent: true, marketing: false });
    assert.equal(rp.status, 409, rp.text);
    assert.equal(rp.json?.code, 'candidate_read_only');
    const versions = sf.records.ContentVersion.size;
    const r = await dana.req('POST', `/api/jobs/apply/${NEW1}`, { cv: { mode: 'profile' }, consent: true, marketing: false });
    assert.equal(r.status, 200, r.text);
    const app = (await db.query(`SELECT id, cv_file_url FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.dana, NEW1])).rows[0];
    assert.equal(app.cv_file_url, `sf:${cvFile.versionId}`, 'the CV on file (in Salesforce)');
    const row = await syncRow('application', app.id, synced);
    const kase = sf.records.Case.get(row.sf_id);
    assert.equal(kase.ContactId, sfId.dana, 'their own Contact, no new one');
    assert.equal(kase.A_CID_cambium__c, CID.dana);
    assert.equal(sf.records.ContentVersion.size, versions, 'no file uploaded');
    const doc = sf.records.ContentVersion.get(cvFile.versionId).ContentDocumentId;
    assert.equal(where('ContentDocumentLink', (l) => l.ContentDocumentId === doc && l.LinkedEntityId === row.sf_id).length, 1, 'linked to the Case');
    const after = await userRow(ids.dana);
    assert.equal(after.legacy_state, 'mirror');
    for (const c of ['first_name', 'cv_file_url', 'has_applied_to_job']) assert.deepEqual(after[c], before[c], `${c} unchanged`);
    assert.equal(after.terms_version !== null, true, 'the terms accepted with the application are recorded');
    assert.equal((await dana.req('POST', `/api/jobs/apply/${NEW1}`, { cv: { mode: 'profile' } })).status !== 200, true, 'once per job');
  });

  await check('staff: in the candidates list; the CV through the hand-over (strict log); no edit', async () => {
    const list = await cm.req('GET', `/api/users?search=${encodeURIComponent(EM.dana)}`);
    assert.equal(list.status, 200, list.text);
    assert.ok(JSON.stringify(list.json).includes(ids.dana), 'listed');
    const f = await cm.req('GET', `/api/files/${ids.dana}`);
    assert.equal(f.status, 200, f.text);
    assert.ok(f.buf.equals(CV_BYTES));
    const logged = (await db.query(`SELECT target FROM audit_log WHERE action = 'candidate.cv_opened' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(logged?.target, ids.dana, 'strict log entry');
    const e = await cm.req('PATCH', `/api/users/${ids.dana}`, { firstName: 'שונה' });
    assert.equal(e.status, 409, e.text);
    assert.equal(e.json?.code, 'candidate_read_only');
    const u = await cm.req('DELETE', `/api/files/?cvFileUrl=${encodeURIComponent(`sf:${cvFile.versionId}`)}&userId=${ids.dana}`);
    assert.equal(u.status, 409, u.text);
  });

  await check('a change in Salesforce: the copy follows (only what changed is read); a new file → the pointer moves', async () => {
    sf.touch('Contact', sfId.dana, { firstName_cambium__c: 'דנה-מעודכנת', citySymbol_cambium__c: '5000' });
    const r = await run(admin, 'candidates');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.counts.updated, 1, JSON.stringify(r.json.data.counts));
    assert.ok(r.json.data.counts.read <= 2, `incremental: ${r.json.data.counts.read} read`);
    const d = await userRow(ids.dana);
    assert.equal(d.first_name, 'דנה-מעודכנת');
    assert.equal(d.city_symbol, 5000);
    const newer = sf.seedFile(sfId.dana, { title: 'קורות חיים 2026', ext: 'docx', bytes: Buffer.from('docx') });
    assert.equal((await run(admin, 'candidates', { full: true })).status, 200);
    assert.equal((await userRow(ids.dana)).cv_file_url, `sf:${newer.versionId}`);
    ids.cvNow = newer.versionId;
  });

  await check('"signing up" with the email of a copy signs in to the copy (no second account)', async () => {
    const r = await signUp(here, { firstName: 'כאן', lastName: 'חדש', email: EM.here, phoneNumber: `05${digits(8)}`, gender: 'female',
      citySymbol: 5000, skills: [], dateOfBirth: '1991-01-01T00:00:00.000Z', hasAppliedToJob: false, consent: true });
    assert.equal(r.json?.code, 'us2', `${r.status} ${r.text}`);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = $1`, [EM.here])).rows[0].n, 1);
    assert.equal((await here.req('GET', '/api/users/me')).json?.data?.readOnly, true);
  });

  await check('an account made here BEFORE the mirror reached the Contact stays this site\'s: linked, empty fields filled', async () => {
    const email = `early-${stamp}@example.test`;
    const early = jar();
    const s = await signUp(early, { firstName: 'מוקדם', lastName: 'כאן', email, phoneNumber: `05${digits(8)}`, gender: 'female', citySymbol: 5000, skills: [],
      dateOfBirth: '1992-02-02T00:00:00.000Z', hasAppliedToJob: false, consent: true });
    assert.equal(s.status, 200, s.text);
    const id = String(s.json.data._id);
    const sfEarly = contact({ AccountId: MOCK_IDS.contactsAccount, ID_cambium__c: '5f00000000000000000000f9', LastName: 'ישן', email_cambium__c: email,
      gender_cambium__c: 'male', dateOfBirth_cambium__c: '1970-01-01', skills_cambium__c: SKILL_B, LastModifiedDate: new Date().toISOString().replace('Z', '+0000') });
    const r = await run(admin, 'candidates', { full: true });
    assert.equal(r.status, 200, r.text);
    const u = await userRow(id);
    assert.equal(u.legacy_state, null, 'not read-only');
    assert.equal(u.legacy_sf_id, sfEarly);
    assert.equal(u.last_name, 'כאן', 'its own values kept');
    assert.equal(u.gender, 'female');
    assert.deepEqual(u.skills, [SKILL_B], 'an empty field filled');
    const p = await early.req('PATCH', '/api/users/me', { firstName: 'מוקדמת' });
    assert.equal(p.status, 200, p.text);
  });

  // =========================== DB guards (server stopped: pglite is one session) ===========================
  await stopServer();
  await check('the database refuses to change a copy or its mark, and to store an application to an existing-site job; a deletion is remembered', async () => {
    await assert.rejects(db.query(`UPDATE users SET first_name = 'x' WHERE id = '${ids.dana}'`), /read-only here/);
    await assert.rejects(db.query(`UPDATE users SET legacy_state = NULL WHERE id = '${ids.dana}'`), /legacy mark/);
    await assert.rejects(db.query(`INSERT INTO job_applications (id, user_id, job_id) VALUES ('${'ab'.repeat(12)}', '${ids.dana}', '${PID}')`), /existing site: no application/);
    await assert.rejects(db.query(`INSERT INTO guest_applications (id, application_id, job_id, full_name, email, phone_number)
                                   VALUES ('${'ac'.repeat(12)}', '${'ad'.repeat(12)}', '${PID}', 'x', 'x@example.test', '0500000000')`), /existing site: no application/);
    assert.equal((await userRow(ids.dana)).first_name, 'דנה-מעודכנת');
    // A deletion request: the copy is removed here, and the mirror won't bring it back.
    await db.query(`DELETE FROM salesforce_sync WHERE record_id = '${ids.noa}'`);
    await db.query(`DELETE FROM users WHERE id = '${ids.noa}'`);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM legacy_candidates_removed WHERE sf_id = '${sfId.noa}'`)).rows[0].n, 1);
  });
  await startServer({ LEGACY_CANDIDATES_MODE: 'mirror' });
  await check('a candidate deleted here is not copied again', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    const r = await run(admin, 'candidates', { full: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.data.counts.skipped.removed_here, 1, JSON.stringify(r.json.data.counts));
    assert.equal(await userByEmail(EM.noa), undefined);
  });

  // =========================== 2. owned (the cutover) ===========================
  await stopServer();
  const cutAt = new Date();
  await startServer({ LEGACY_CANDIDATES_MODE: 'owned' });

  await check('cutover at boot: logged; editable; the mirror refuses to run', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
    await waitBootReads(admin, cutAt, ['jobs']);
    const l = (await db.query(`SELECT details FROM audit_log WHERE action = 'legacy_candidates.taken_over' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.ok((l?.details?.count ?? 0) >= 2, JSON.stringify(l));
    assert.equal((await userRow(ids.dana)).legacy_state, 'owned');
    assert.equal((await run(admin, 'candidates')).json?.code, 'legacy_mirror_off');
    assert.equal((await candidateLogin(dana, EM.dana)).status, 200);
    assert.equal((await dana.req('GET', '/api/users/me')).json.data.readOnly, false);
  });

  await check('a change goes to THEIR Contact in full: no new Contact, never Beta, ID_cambium__c and the Account kept', async () => {
    const contacts = sf.records.Contact.size;
    const r = await dana.req('PATCH', '/api/users/me', { firstName: 'דנה', lastName: 'לוי-כהן', phoneNumber: PHONE.dana });
    assert.equal(r.status, 200, r.text);
    await syncRow('candidate', ids.dana, synced);
    const c = sf.records.Contact.get(sfId.dana);
    assert.equal(sf.records.Contact.size, contacts, 'no new Contact');
    assert.equal(c.lastName_cambium__c, 'לוי-כהן', 'written in full');
    assert.equal(c.firstName_cambium__c, 'דנה', 'overwritten (full writing)');
    assert.equal(c.ID_cambium__c, CID.dana);
    assert.equal(c.AccountId, MOCK_IDS.contactsAccount);
    assert.equal(c.Beta__c, false, 'never marked Beta');
    assert.equal(c.CV_link_cambium__c, 'https://old-bucket.example.test/cv.pdf', 'the CV link is not replaced by the pointer');
  });

  await check('applying works: the Case names the old key and the CV file is linked, not uploaded again', async () => {
    const versions = sf.records.ContentVersion.size;
    // The existing site's job (still mirrored) takes no application, after the candidates' cutover too.
    const legacy = await dana.req('POST', `/api/jobs/apply/${PID}`, { cv: { mode: 'profile' }, consent: true, marketing: false });
    assert.equal(legacy.status, 409, legacy.text);
    assert.equal(legacy.json?.code, 'job_on_existing_site');
    const r = await dana.req('POST', `/api/jobs/apply/${NEW2}`, { cv: { mode: 'profile' }, consent: true, marketing: false });
    assert.equal(r.status, 200, r.text);
    const app = (await db.query(`SELECT id, cv_file_url FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.dana, NEW2])).rows[0];
    assert.equal(app.cv_file_url, `sf:${ids.cvNow}`);
    const row = await syncRow('application', app.id, synced);
    const kase = sf.records.Case.get(row.sf_id);
    assert.equal(kase.A_CID_cambium__c, CID.dana);
    assert.equal(kase.ContactId, sfId.dana);
    assert.equal(sf.records.ContentVersion.size, versions, 'no file uploaded');
    const doc = sf.records.ContentVersion.get(ids.cvNow).ContentDocumentId;
    assert.ok(where('ContentDocumentLink', (l) => l.ContentDocumentId === doc && l.LinkedEntityId === row.sf_id).length === 1, 'linked to the Case');
  });

  // =========================== 3. back to mirror (the rollback) ===========================
  await stopServer();
  await startServer({ LEGACY_CANDIDATES_MODE: 'mirror' });
  await check('rollback: read-only again (logged); what they changed is kept', async () => {
    assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
    const l = (await db.query(`SELECT details FROM audit_log WHERE action = 'legacy_candidates.returned_to_mirror' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.ok((l?.details?.count ?? 0) >= 2, JSON.stringify(l));
    assert.equal((await candidateLogin(dana, EM.dana)).status, 200);
    const me = await dana.req('GET', '/api/users/me');
    assert.equal(me.json.data.readOnly, true);
    assert.equal(me.json.data.user.lastName, 'לוי-כהן');
    assert.equal((await dana.req('PATCH', '/api/users/me', { firstName: 'x' })).status, 409);
  });

  await check('nothing personal in the server\'s console output; nothing deleted in Salesforce', async () => {
    await sleep(500);
    const out = fs.readFileSync(logFile, 'utf-8').toLowerCase();
    for (const e of Object.values(EM)) assert.ok(!out.includes(e.toLowerCase()), `log has ${e}`);
    for (const p of Object.values(PHONE)) assert.ok(!out.includes(p), 'log has a phone');
    assert.ok(!/דנה|נועה|לוי/.test(out), 'log has a name');
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
