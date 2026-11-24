// Salesforce integration end to end, against a MOCK Salesforce (test/helpers/mockSalesforce.mjs) — never a real org.
// The local server must run with Salesforce ON and pointed at the mock (DEV_MODE only), on a FRESH dev DB:
//   DEV_MODE=true ENABLE_SALESFORCE=true SALESFORCE_LOGIN_URL=http://127.0.0.1:3198 SALESFORCE_CLIENT_ID=e2e-sf-client
//   SALESFORCE_CLIENT_SECRET=e2e-sf-secret-not-real SALESFORCE_CONTACTS_ACCOUNT_ID=001000000000AAAAAA
//   SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID=001000000000BBBBBB SALESFORCE_CASE_ACCOUNT_ID=001000000000CCCCCC
//   SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID=012000000000OrgAAA SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID=012000000000AppAAA
//   SALESFORCE_CASE_RECORD_TYPE_ID=012000000000JobAAA   (+ the usual values of server/.env.example)
// then:  BASE=http://localhost:3100 DATABASE_URL=postgresql://… node test/e2e-salesforce.mjs
// Covers: admin-only state with no secret; the read-only connection check (no write); candidate → one Contact (+ CV);
// profile change → same Contact; job here → one job Case, edit → same Case; imported job → never a Case (no application
// to it here); application → Case linked to Contact with its own CV once; quick application → Contact + Case +
// CV after a failure in the middle, no duplicates; employer → company Account + Contact under it, their job's Case points at
// the Contact, an archive → Closed; Cases never auto-assigned; no backlog route; 503 → retry with
// backoff, 400 → stops, admin retry; expired session → new token; strict log before sending; nothing deleted; codes
// only in the DB; every Contact, Case and Account marked Beta; threshold condition (תנאי סף) → its field on the job
// Case (edit → same Case, removed → cleared), the confirmation + time on the application Case, a missing field → named
// by the check and skipped (the Case still goes). Restart the server first (sign-in and write limits).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin } from './helpers/staffLogin.mjs';
import { devCode, signUp } from './helpers/candidate.mjs';
import { startMockSalesforce, MOCK_IDS, MOCK_CLIENT_SECRET, MOCK_CLIENT_ID } from './helpers/mockSalesforce.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) throw new Error('DATABASE_URL of the LOCAL dev database is required');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const pg = (await import('pg')).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const sf = await startMockSalesforce({ port: Number(process.env.MOCK_SF_PORT || 3198) });

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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
const refused = (r) => r.status === 401 || r.status === 403 || (r.status === 400 && /^(Forbidden|Unauthorized|au\d+)$/.test(String(r.json?.code ?? '')));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;
const pdf = async () => { const d = await PDFDocument.create(); d.addPage().drawText('CV'); return Buffer.from(await d.save()); };
const upload = async (client, token, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdf()], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits for a salesforce_sync row to reach a state (the worker runs ~1.5 s after a change). */
const syncRow = async (kind, id, until, ms = 15000) => {
  const end = Date.now() + ms;
  let row;
  while (Date.now() < end) {
    row = (await db.query(`SELECT *, queued_at IS NOT NULL AS queued FROM salesforce_sync WHERE kind = $1 AND record_id = $2`, [kind, id])).rows[0];
    if (row && until(row)) return row;
    await sleep(250);
  }
  throw new Error(`${kind} ${id}: sync row never reached the state (last: ${JSON.stringify(row && { sf: row.sf_id, code: row.last_error_code, queued: row.queued, pushed: !!row.last_pushed_at })})`);
};
const synced = (r) => !!r.last_pushed_at && !r.queued && !r.last_error_code;
const where = (object, f) => [...sf.records[object].values()].filter(f);
/** Forces a row in backoff to be due now and runs the queue (the admin "retry" button does the same for failures). */
const dueNow = async (kind, id) => db.query(`UPDATE salesforce_sync SET next_attempt_at = now() WHERE kind = $1 AND record_id = $2`, [kind, id]);

const anon = jar(), admin = jar(), cm = jar(), cand = jar(), cand2 = jar(), guest = jar(), emp = jar();
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const skillId = (await anon.req('GET', '/api/skills')).json.data.skills[0]._id;
const C = { email: `sf-c-${stamp}@example.test`, phone: phone() };
const ids = {};

await check('setup: Salesforce is on (pointed at the mock) and the admin sees it; the secret and client id never shown', async () => {
  assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  const r = await admin.req('GET', '/api/admin/security/salesforce');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.enabled, true, `start the server with the mock values (problems: ${r.json.data.problems})`);
  assert.deepEqual(r.json.data.problems, []);
  assert.doesNotMatch(r.text, new RegExp(MOCK_CLIENT_SECRET));
  assert.doesNotMatch(r.text, new RegExp(MOCK_CLIENT_ID));
  const secret = r.json.data.settings.find((s) => s.name === 'SALESFORCE_CLIENT_SECRET');
  assert.equal(secret.set, true); assert.equal('value' in secret, false);
  assert.equal(r.json.data.settings.find((s) => s.name === 'SALESFORCE_CONTACTS_ACCOUNT_ID').value, MOCK_IDS.contactsAccount);
});

await check('connection check: everything found, nothing written, logged as salesforce.checked', async () => {
  const writesBefore = sf.seen.writes.length;
  const r = await admin.req('POST', '/api/admin/security/salesforce/check', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.ok, true, JSON.stringify(r.json.data.items.filter((i) => !i.ok)));
  for (const id of ['settings', 'token', 'api_version', 'object_Contact', 'object_Case', 'object_Account', 'beta_Contact', 'beta_Case', 'beta_Account', 'fields_candidate', 'fields_job',
    'fields_application', 'fields_employer', 'fields_employer_account', 'fields_threshold', 'accounts', 'record_type_SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID']) {
    assert.ok(r.json.data.items.find((i) => i.id === id)?.ok, `${id} ok`);
  }
  assert.equal(r.json.data.items.find((i) => i.id === 'fields_threshold').warn, undefined, 'all threshold fields in use');
  assert.ok(r.json.data.items.filter((i) => i.id.startsWith('record_type_')).every((i) => i.ok));
  assert.equal(sf.seen.writes.length, writesBefore, 'the check writes nothing');
  assert.doesNotMatch(r.text, /mock-[0-9a-f]{24}|e2e-sf-secret/); // no token, no secret
  const a = (await db.query(`SELECT details FROM audit_log WHERE action = 'salesforce.checked' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a?.details?.ok, true);
});

await check('candidate sign-up → one Contact in the candidates\' Account, after a strict log entry naming the candidate', async () => {
  const r = await signUp(cand, {
    firstName: 'דנה', lastName: 'סיילס', email: C.email, phoneNumber: C.phone, dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'female', citySymbol: city.citySymbol, skills: [skillId], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  ids.cand = String(r.json.data._id);
  const row = await syncRow('candidate', ids.cand, synced);
  const contacts = where('Contact', (c) => c.ID_cambium__c === ids.cand);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].Id, row.sf_id);
  assert.equal(contacts[0].AccountId, MOCK_IDS.contactsAccount);
  assert.equal(contacts[0].Email, C.email);
  assert.equal(contacts[0].Birthdate, '1990-01-01');
  const log = (await db.query(`SELECT details FROM audit_log WHERE action = 'salesforce.pushed' AND actor = 'system:salesforce-sync'
    AND details->>'kind' = 'candidate' AND details->'ids' ? $1`, [ids.cand])).rows;
  assert.ok(log.length >= 1, 'strict salesforce.pushed with the candidate id');
});

await check('profile change → the same Contact is updated (no second one)', async () => {
  const r = await cand.req('PATCH', '/api/users/me', { firstName: 'דנית' });
  assert.equal(r.status, 200, r.text);
  await sleep(300);
  await syncRow('candidate', ids.cand, (x) => synced(x) && x.attempts >= 2);
  const contacts = where('Contact', (c) => c.ID_cambium__c === ids.cand);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].FirstName, 'דנית');
});

await check('a job created here → one job Case (record type + Account); an edit → the same Case', async () => {
  const r = await cm.req('POST', '/api/jobs', {
    title: `SF job ${stamp}`, jobScope: ['FullTime'], companyName: 'SF Co', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: Number(city.citySymbol), description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, isSelfApply: false,
  });
  assert.equal(r.status, 200, r.text);
  ids.job = r.json.data.id ?? r.json.data._id;
  await syncRow('job', ids.job, synced);
  let cases = where('Case', (c) => c.PID_cambium__c === ids.job);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].RecordTypeId, MOCK_IDS.jobsRecordType);
  assert.equal(cases[0].AccountId, MOCK_IDS.jobsAccount);
  const e = await cm.req('PATCH', `/api/jobs/${ids.job}`, { title: `SF job ${stamp} v2`, status: 'Active' });
  assert.equal(e.status, 200, e.text);
  await sleep(300);
  await syncRow('job', ids.job, (x) => synced(x) && x.attempts >= 2);
  cases = where('Case', (c) => c.PID_cambium__c === ids.job);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].Position_cambium__c, `SF job ${stamp} v2`);
  assert.equal(cases[0].RecordTypeId, MOCK_IDS.jobsRecordType);
});

await check('application with a job-only CV → one Case linked to the Contact, job and candidate, with that CV once', async () => {
  const t = crypto.randomUUID();
  assert.equal((await upload(cand, t, 'job_cv.pdf')).status, 200);
  const r = await cand.req('POST', `/api/jobs/apply/${ids.job}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/job_cv.pdf` } });
  assert.equal(r.status, 200, r.text);
  ids.app = (await db.query(`SELECT id FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.cand, ids.job])).rows[0].id;
  const row = await syncRow('application', ids.app, synced);
  const cases = where('Case', (c) => c.A_ID_cambium__c === ids.app);
  assert.equal(cases.length, 1);
  const contact = where('Contact', (c) => c.ID_cambium__c === ids.cand)[0];
  assert.deepEqual([cases[0].ContactId, cases[0].A_PID_cambium__c, cases[0].A_CID_cambium__c, cases[0].RecordTypeId, cases[0].AccountId],
    [contact.Id, ids.job, ids.cand, MOCK_IDS.applicationsRecordType, MOCK_IDS.applicationsAccount]);
  const links = where('ContentDocumentLink', (l) => l.LinkedEntityId === cases[0].Id);
  assert.equal(links.length, 1, 'the application CV is on the Case');
  assert.ok(row.synced_cv_key, 'the CV sent is recorded');
  // Sent again (as after a failure that came after Salesforce had made the Case): no second Case, no second file.
  await db.query(`UPDATE salesforce_sync SET last_error_code = 'http_503', queued_at = NULL WHERE kind = 'application' AND record_id = $1`, [ids.app]);
  assert.equal((await admin.req('POST', '/api/admin/security/salesforce/retry', { kind: 'application' })).status, 200);
  await syncRow('application', ids.app, (x) => synced(x) && x.attempts >= 2);
  assert.equal(where('Case', (c) => c.A_ID_cambium__c === ids.app).length, 1);
  assert.equal(where('ContentDocumentLink', (l) => l.LinkedEntityId === cases[0].Id).length, 1);
});

await check('a job imported from the existing site never gets a Case, and takes no application here (409 job_on_existing_site)', async () => {
  const imp = (await db.query(`SELECT id FROM jobs WHERE imported_from_live AND deleted_at IS NULL AND status = 'Active' LIMIT 1`)).rows[0];
  assert.ok(imp, 'an imported job (seed) exists on a fresh DB');
  ids.imported = imp.id;
  // No path queues it (the queue refuses it).
  assert.equal((await db.query(`SELECT 1 FROM salesforce_sync WHERE kind = 'job' AND record_id = $1`, [imp.id])).rowCount, 0);
  const a = await cand.req('POST', `/api/jobs/apply/${imp.id}`, { cv: { mode: 'profile' } });
  // Owner, 23.11.2026: applications to the existing site's jobs are not taken here (nothing stored, nothing queued).
  assert.equal(a.status, 409, a.text);
  assert.equal(a.json?.code, 'job_on_existing_site');
  assert.equal((await db.query(`SELECT 1 FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.cand, imp.id])).rowCount, 0);
  assert.equal(where('Case', (c) => c.PID_cambium__c === imp.id).length, 0, 'no job Case for an imported job');
  assert.equal(sf.seen.writes.filter((w) => w.object === 'Case' && w.method === 'PATCH' && where('Case', (c) => c.Id === w.id && c.PID_cambium__c === imp.id).length).length, 0);
});

await check('quick application: a failure after the Contact → retried, still ONE Contact and ONE Case, CV on both', async () => {
  const pushes = (await syncRow('job', ids.job, synced)).attempts;
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${ids.job}/board`, { guestModeOverride: 'quick' })).status, 200);
  await sleep(300);
  await syncRow('job', ids.job, (x) => synced(x) && x.attempts > pushes); // the job's own update goes first
  const t = crypto.randomUUID();
  assert.equal((await upload(guest, t, 'guest_cv.pdf')).status, 200);
  sf.failNext(1, 503, 'SERVER_UNAVAILABLE', 'Case');
  const g = await guest.req('POST', '/api/jobs/guestApply', {
    consent: true, jobData: { _id: ids.job },
    guestData: { fullName: 'אורח מהיר', email: `sf-g-${stamp}@example.test`, phoneNumber: phone(), cvFilePath: `${t}/guest_cv.pdf` },
  });
  assert.equal(g.status, 200, g.text);
  ids.guest = (await db.query(`SELECT id FROM guest_applications WHERE job_id = $1 AND email = lower($2)`, [ids.job, `sf-g-${stamp}@example.test`])).rows[0].id;
  const failed = await syncRow('guest_application', ids.guest, (x) => /^http_503/.test(x.last_error_code ?? ''));
  assert.equal(failed.queued, true, 'a 503 is retried');
  assert.ok(new Date(failed.next_attempt_at) > new Date(Date.now() + 30_000), 'after a wait (backoff)');
  assert.ok(failed.sf_contact_id, 'the Contact made before the failure is remembered');
  assert.equal((await db.query(`SELECT salesforce_error FROM guest_applications WHERE id = $1`, [ids.guest])).rows[0].salesforce_error, failed.last_error_code);
  await dueNow('guest_application', ids.guest);
  await admin.req('POST', '/api/admin/security/salesforce/retry', { kind: 'guest_application' });
  const ok = await syncRow('guest_application', ids.guest, synced);
  const contacts = where('Contact', (c) => c.ID_cambium__c === ids.guest);
  assert.equal(contacts.length, 1, 'no second Contact');
  const cases = where('Case', (c) => c.A_CID_cambium__c === ids.guest);
  assert.equal(cases.length, 1, 'no second Case');
  assert.equal(cases[0].ContactId, contacts[0].Id);
  assert.equal(ok.sf_contact_id, contacts[0].Id);
  const links = where('ContentDocumentLink', (l) => l.LinkedEntityId === cases[0].Id || l.LinkedEntityId === contacts[0].Id);
  assert.equal(links.length, 2, 'one file, linked to the Case and the Contact');
  assert.equal(new Set(links.map((l) => l.ContentDocumentId)).size, 1);
  assert.ok((await db.query(`SELECT salesforce_sent_at FROM guest_applications WHERE id = $1`, [ids.guest])).rows[0].salesforce_sent_at);
});

await check('a refusal (HTTP 400) stops at once, shows the code to admins (not the body), and an admin retry sends it', async () => {
  const r2 = await signUp(cand2, {
    firstName: 'רון', lastName: 'שני', email: `sf-c2-${stamp}@example.test`, phoneNumber: phone(), dateOfBirth: '1991-01-01T00:00:00.000Z',
    gender: 'male', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r2.status, 200, r2.text);
  ids.cand2 = String(r2.json.data._id);
  await syncRow('candidate', ids.cand2, synced);
  sf.failNext(1, 400, 'REQUIRED_FIELD_MISSING', 'Case');
  assert.equal((await cand2.req('POST', `/api/jobs/apply/${ids.job}`, { cv: { mode: 'profile' } })).status, 200);
  ids.app2 = (await db.query(`SELECT id FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.cand2, ids.job])).rows[0].id;
  const row = await syncRow('application', ids.app2, (x) => !!x.last_error_code);
  assert.equal(row.last_error_code, 'http_400_REQUIRED_FIELD_MISSING');
  assert.equal(row.queued, false, 'not retried by itself');
  const s = await admin.req('GET', '/api/admin/security/salesforce');
  const f = s.json.data.failures.find((x) => x.recordId === ids.app2);
  assert.deepEqual([f.kind, f.code, f.willRetry], ['application', 'http_400_REQUIRED_FIELD_MISSING', false]);
  assert.equal(s.json.data.counts.application.failed >= 1, true);
  assert.doesNotMatch(s.text, /a@b\.example|mock failure/); // the third-party message never reaches the DB or the screen
  const rr = await admin.req('POST', '/api/admin/security/salesforce/retry', { kind: 'application' });
  assert.equal(rr.status, 200, rr.text);
  assert.ok(rr.json.data.queued >= 1);
  await syncRow('application', ids.app2, synced);
  assert.equal(where('Case', (c) => c.A_ID_cambium__c === ids.app2).length, 1);
  assert.ok((await db.query(`SELECT 1 FROM audit_log WHERE action = 'salesforce.retried'`)).rowCount >= 1);
});

await check('an employer → an Account for the company + a Contact under it (never the candidates\'), both Beta and by the employer id', async () => {
  const email = `sf-e-${stamp}@example.test`;
  const code = await devCode(emp, email);
  const v = await emp.req('POST', '/api/auth/email/verify', { email, code });
  assert.equal(v.json?.data?.status, 'signup', v.text);
  const r = await emp.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'מיכל', lastName: 'מעסיקה', companyName: 'חברת סיילס', phone: phone(), consent: true, marketingConsent: false,
  });
  assert.equal(r.status, 200, r.text);
  ids.emp = String(r.json.data.user._id ?? r.json.data.user.id);
  const row = await syncRow('employer', ids.emp, synced);
  const c = sf.records.Contact.get(row.sf_id);
  const acc = sf.records.Account.get(row.sf_account_id);
  assert.ok(acc, 'the company Account was made');
  assert.equal(c.AccountId, acc.Id);
  assert.notEqual(c.AccountId, MOCK_IDS.contactsAccount);
  assert.deepEqual([acc.Name, acc.RecordTypeId, acc.SKEELZ_Employer_Id__c, acc.Beta__c], ['חברת סיילס', MOCK_IDS.employerAccountRecordType, ids.emp, true]);
  assert.deepEqual([c.FirstName, c.SKEELZ_Employer_Id__c, c.Is_SKEELZ_Employer__c, c.Beta__c], ['מיכל', ids.emp, true, true]);
  assert.equal(c.Description, `SKEELZ Jobs employer account ${ids.emp}`);
  assert.equal(c.ID_cambium__c, undefined, 'not a candidate Contact');
  // A change of company name renames the same Account (no second one); the Contact stays the same.
  const u = await emp.req('PATCH', '/api/employer/me', { companyName: 'חברת סיילס 2' });
  assert.equal(u.status, 200, u.text);
  await sleep(300);
  await syncRow('employer', ids.emp, (x) => synced(x) && x.attempts >= 2);
  assert.equal(where('Account', (a) => a.SKEELZ_Employer_Id__c === ids.emp).length, 1);
  assert.equal(where('Contact', (x) => x.SKEELZ_Employer_Id__c === ids.emp).length, 1);
  assert.equal(sf.records.Account.get(row.sf_account_id).Name, 'חברת סיילס 2');
});

await check('a job of that employer points at their Contact; archived → PStatus Closed, restored → Active (same Case)', async () => {
  await db.query(`INSERT INTO employer_jobs (job_id, user_id, via) VALUES ($1, $2, 'submission') ON CONFLICT DO NOTHING`, [ids.job, ids.emp]);
  const contactId = (await db.query(`SELECT sf_id FROM salesforce_sync WHERE kind = 'employer' AND record_id = $1`, [ids.emp])).rows[0].sf_id;
  const before = (await db.query(`SELECT attempts FROM salesforce_sync WHERE kind = 'job' AND record_id = $1`, [ids.job])).rows[0].attempts;
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  const a = await cm.req('POST', `/api/admin/jobs/${ids.job}/archive`, {});
  assert.equal(a.status, 200, a.text);
  await syncRow('job', ids.job, (x) => synced(x) && x.attempts > before);
  let cases = where('Case', (x) => x.PID_cambium__c === ids.job);
  assert.equal(cases.length, 1);
  assert.deepEqual([cases[0].PStatus__c, cases[0].ContactId], ['Closed', contactId]);
  const r2 = await cm.req('POST', `/api/admin/jobs/${ids.job}/restore`, {});
  assert.equal(r2.status, 200, r2.text);
  await syncRow('job', ids.job, (x) => synced(x) && x.attempts > before + 1);
  cases = where('Case', (x) => x.PID_cambium__c === ids.job);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].PStatus__c, 'Active');
});

await check('threshold condition: on the job Case (edit → same Case, removed → cleared); confirmation + time on the application Case; a missing field → named by the check and skipped', async () => {
  const COND = 'לפחות שנתיים ניסיון במכירות';
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  const r = await cm.req('POST', '/api/jobs', {
    title: `SF threshold ${stamp}`, jobScope: ['FullTime'], companyName: 'SF Co', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: Number(city.citySymbol), description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, isSelfApply: false, thresholdCondition: COND,
  });
  assert.equal(r.status, 200, r.text);
  const jobId = r.json.data.id ?? r.json.data._id;
  let row = await syncRow('job', jobId, synced);
  const caseOf = () => where('Case', (c) => c.PID_cambium__c === jobId);
  assert.equal(caseOf().length, 1);
  assert.equal(caseOf()[0].Threshold_Condition__c, COND);
  // Edited → the same Case carries the new text.
  assert.equal((await cm.req('PATCH', `/api/jobs/${jobId}`, { thresholdCondition: 'רישיון עריכת דין בתוקף', status: 'Active' })).status, 200);
  await sleep(300);
  row = await syncRow('job', jobId, (x) => synced(x) && caseOf()[0]?.Threshold_Condition__c === 'רישיון עריכת דין בתוקף');
  assert.equal(caseOf().length, 1);
  assert.equal(caseOf()[0].Id, row.sf_id);

  // An application confirms it → Threshold_Confirmed__c + the time on its Case. Without the confirmation: refused.
  assert.equal((await cand.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'profile' } })).json?.code, 'threshold_not_confirmed');
  const a = await cand.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'profile' }, thresholdConfirmed: true });
  assert.equal(a.status, 200, a.text);
  const app = (await db.query(`SELECT id, threshold_confirmed_at FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.cand, jobId])).rows[0];
  await syncRow('application', app.id, synced);
  const ac = where('Case', (c) => c.A_ID_cambium__c === app.id);
  assert.equal(ac.length, 1);
  assert.equal(ac[0].Threshold_Confirmed__c, true);
  assert.equal(ac[0].Threshold_Confirmed_At__c, new Date(app.threshold_confirmed_at).toISOString());
  assert.equal('Threshold_Condition__c' in ac[0], false, 'the text is not stored with the application, so not sent');
  // An application to a job without a condition → not confirmed, no time.
  const plain = where('Case', (c) => c.A_ID_cambium__c === ids.app)[0];
  assert.equal(plain.Threshold_Confirmed__c, false);
  assert.equal('Threshold_Confirmed_At__c' in plain, false);

  // The condition removed → cleared on the same Case.
  assert.equal((await cm.req('PATCH', `/api/jobs/${jobId}`, { thresholdCondition: '', status: 'Active' })).status, 200);
  await sleep(300);
  await syncRow('job', jobId, (x) => synced(x) && caseOf()[0]?.Threshold_Condition__c === null);
  assert.equal(caseOf().length, 1);

  // The fields missing in the org → the check names them (a warning, not a failure) and the Case still goes without them.
  const TH = ['Threshold_Condition__c', 'Threshold_Confirmed_At__c'];
  sf.dropFields('Case', TH);
  try {
    const c = await admin.req('POST', '/api/admin/security/salesforce/check', {});
    assert.equal(c.status, 200, c.text);
    const item = c.json.data.items.find((i) => i.id === 'fields_threshold');
    assert.deepEqual([item.ok, item.warn, item.code], [true, true, 'threshold_fields_missing']);
    for (const f of TH) assert.ok(item.detail.some((d) => d.startsWith(`Case.${f}: missing`)), `${f} named`);
    assert.ok(item.detail.includes('Case.Threshold_Confirmed__c: in use'));
    assert.equal(c.json.data.ok, true, 'a missing threshold field does not fail the check');
    assert.equal((await cm.req('PATCH', `/api/jobs/${jobId}`, { title: `SF threshold ${stamp} v2`, thresholdCondition: COND, status: 'Active' })).status, 200);
    await sleep(300);
    await syncRow('job', jobId, (x) => synced(x) && caseOf()[0]?.Position_cambium__c === `SF threshold ${stamp} v2`);
    assert.equal(caseOf()[0].Threshold_Condition__c, null, 'not written while the field is missing');
  } finally {
    sf.restoreFields('Case', TH);
    await admin.req('POST', '/api/admin/security/salesforce/check', {}); // fresh describes for the rest
  }
});

await check('an expired Salesforce session → a new token, and the change still goes through', async () => {
  const before = sf.seen.tokens;
  sf.expireTokens();
  assert.equal((await cand.req('PATCH', '/api/users/me', { lastName: 'סיילסית' })).status, 200);
  await sleep(300);
  await syncRow('candidate', ids.cand, (x) => synced(x) && where('Contact', (c) => c.ID_cambium__c === ids.cand)[0].LastName === 'סיילסית');
  assert.ok(sf.seen.tokens > before, 'signed in again');
});

await check('nothing was deleted in Salesforce; the sync table holds ids and codes only', async () => {
  assert.equal(sf.seen.deletes, 0);
  // Owner's rule: every Contact and Case the site wrote is marked Beta (kept out of the team's current lists).
  // Cases keep the integration user as owner: no write ran the assignment rules.
  const caseWrites = sf.seen.writes.filter((w) => w.object === 'Case');
  assert.ok(caseWrites.length > 0);
  assert.deepEqual(caseWrites.filter((w) => w.autoAssign !== 'FALSE').map((w) => w.id), [], 'Case writes without Sforce-Auto-Assign: FALSE');
  for (const object of ['Contact', 'Case', 'Account']) {
    const all = [...sf.records[object].values()].filter((x) => !Object.values(MOCK_IDS).includes(x.Id)); // not the configured Accounts
    assert.ok(all.length > 0, `${object}s were written`);
    assert.deepEqual(all.filter((r) => r.Beta__c !== true).map((r) => r.Id), [], `${object}s without Beta`);
  }
  const rows = (await db.query(`SELECT * FROM salesforce_sync`)).rows;
  const text = JSON.stringify(rows);
  for (const bad of [C.email, 'a@b.example', 'mock failure', 'דנה', MOCK_CLIENT_SECRET]) assert.ok(!text.includes(bad), `sync table holds ${bad}`);
  // Every person sent was named in a strict log entry by the sync worker.
  const logged = new Set((await db.query(`SELECT jsonb_array_elements_text(details->'ids') AS id FROM audit_log WHERE action = 'salesforce.pushed'`)).rows.map((r) => r.id));
  for (const id of [ids.cand, ids.cand2, ids.guest, ids.emp]) assert.ok(logged.has(id), `log names ${id}`);
});

await check('no backlog: there is no way to send what happened before the switch-on; retry refuses bad kinds', async () => {
  const b = await admin.req('POST', '/api/admin/security/salesforce/backlog', { kind: 'application', limit: 10 });
  assert.ok(b.status === 404 || b.status === 400, `backlog route answered ${b.status}`);
  assert.equal((await admin.req('POST', '/api/admin/security/salesforce/retry', { kind: 'x' })).status, 400);
  const st = await admin.req('GET', '/api/admin/security/salesforce');
  assert.equal(st.status, 200);
  assert.doesNotMatch(st.text, /backlog/);
});

await check('admin only: content managers and anonymous visitors are refused everywhere (state, check, retry)', async () => {
  for (const [m, p] of [['GET', '/api/admin/security/salesforce'], ['POST', '/api/admin/security/salesforce/check'],
    ['POST', '/api/admin/security/salesforce/retry']]) {
    const body = m === 'GET' ? undefined : {};
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200); // signed in as a content manager for each try
    assert.ok(refused(await cm.req(m, p, body)), `content manager ${m} ${p}`);
    assert.ok(refused(await anon.req(m, p, body)), `anonymous ${m} ${p}`);
  }
});

await db.end();
await sf.close();
for (const r of results) console.log(r[0], '-', r[1], r[2] ? `\n    ${r[2]}` : '');
const failedCount = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
