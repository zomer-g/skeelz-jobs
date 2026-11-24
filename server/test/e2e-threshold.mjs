// End-to-end checks for the threshold condition (תנאי סף; docs/jobs-management.md "Threshold condition") against a
// LOCAL server: staff set / change / clear it (plain text, length-checked); it reaches the job page, the board, the
// public API and MCP; a job without one is applied to as before; a job with one refuses every way to apply without
// the confirmation (400 threshold_not_confirmed, nothing claimed) and accepts it with; the employer form and an
// employer's edit request carry it (pending until a content manager approves); jobs imported from the existing site
// stay untouched.
//   BASE=http://localhost:3100 [DATABASE_URL=postgresql://…] node test/e2e-threshold.mjs
// Needs DEV_MODE=true + EMAIL_CODE_SIGNIN_ENABLED=true (candidate / employer sign-in by the dev email code) and the
// dev staff from server/.env.example. Uses 2 of the per-IP employer-form submissions: restart the server first.
// With DATABASE_URL it also checks what the application rows store. Never point this at production.
import assert from 'node:assert/strict';
import { ensureImportedJob, isSkip, skip, summary } from './helpers/localDb.mjs';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin } from './helpers/staffLogin.mjs';
import { devCode, signUp } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== 'true') {
  throw new Error('e2e writes data: run it against localhost only');
}
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
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
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push([isSkip(e) ? 'SKIP' : 'FAIL', name, e.message]); }
};

const db = process.env.DATABASE_URL
  ? await (async () => { const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; })()
  : null;

const upload = async (client, token, name = 'cv_test.pdf') => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Test CV');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await doc.save())], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
const mcpGetJob = async (id) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_job', arguments: { id } } }),
  });
  const j = await r.json();
  return j.result?.isError ? null : JSON.parse(j.result.content[0].text);
};

const anon = jar();
const cm = jar();
const stamp = Date.now();
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'content manager sign-in (mock xhostd SSO)');
// Quick (guest) applications open, CV optional, so only the threshold condition decides here.
const originalDefaults = (await cm.req('GET', '/api/admin/settings/apply-policy')).json.data;
await cm.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });

const skills = (await anon.req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;
const COND = 'לפחות שנתיים ניסיון בשיווק ומכירות.\nרישיון נהיגה בתוקף.';
const createJob = (title, extra = {}) => cm.req('POST', '/api/jobs', {
  title, jobScope: ['FullTime'], companyName: 'E2E Threshold', publishDate: new Date(Date.now() - 1000).toISOString(),
  citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
  isSponsored: false, isMarked: false, contactPersonEmail: `jobs-${stamp}@employer.test`, ...extra,
});
const tag = `E2ETH${stamp}`.slice(0, 22);
const guestApply = (jobId, extra = {}, guest = {}) => anon.req('POST', '/api/jobs/guestApply', {
  jobData: { _id: jobId },
  guestData: { fullName: 'Guest Threshold', email: `th-${crypto.randomUUID().slice(0, 8)}@example.test`, phoneNumber: '0504444444', ...guest },
  consent: true, ...extra,
});
const candidate = async (email) => {
  const c = jar();
  const r = await signUp(c, {
    firstName: 'סף', lastName: 'בדיקה', email, phoneNumber: `05${String(crypto.randomInt(1e7, 1e8))}`, citySymbol: 9000,
    gender: 'other', dateOfBirth: '1990-01-01T00:00:00.000Z', skills: [], cvFileUrl: '', hasAppliedToJob: false,
    consent: true, marketingConsent: false,
  });
  assert.equal(r.status, 200, r.text);
  return c;
};

let PLAIN = '', COND_JOB = '';
await check('staff: set on create (tags removed, line breaks kept), length checked (400), shown in the staff list', async () => {
  const plain = await createJob(`${tag} plain`);
  assert.equal(plain.status, 200, plain.text);
  PLAIN = plain.json.data.id;
  const withOne = await createJob(`${tag} cond`, { thresholdCondition: `  <b>${COND.split('\n')[0]}</b>\n${COND.split('\n')[1]}  ` });
  assert.equal(withOne.status, 200, withOne.text);
  COND_JOB = withOne.json.data.id;
  assert.equal((await createJob(`${tag} long`, { thresholdCondition: 'א'.repeat(501) })).status, 400, 'over 500 refused');
  const short = await createJob(`${tag} short`, { thresholdCondition: 'אב' });
  assert.equal(short.status, 400);
  assert.equal(short.json.code, 'threshold_condition_too_short');
  const list = (await cm.req('GET', '/api/admin/jobs/with-comments')).json.data.jobs;
  assert.equal(list.find((j) => j._id === COND_JOB)?.thresholdCondition, COND);
  assert.equal(list.find((j) => j._id === PLAIN)?.thresholdCondition, null);
});

await check('public: the job page, the board, the public API and MCP carry it (text or null)', async () => {
  assert.equal((await anon.req('GET', `/api/jobs/${COND_JOB}`)).json.data.thresholdCondition, COND);
  assert.equal((await anon.req('GET', `/api/jobs/${PLAIN}`)).json.data.thresholdCondition, null);
  const board = (await anon.req('GET', '/api/jobs/active')).json.data.jobs;
  assert.equal(board.find((j) => j._id === COND_JOB)?.thresholdCondition, COND);
  const api = await anon.req('GET', `/api/public/v1/jobs/${COND_JOB}`);
  assert.equal(api.status, 200, api.text);
  assert.equal((api.json.data ?? api.json).thresholdCondition, COND);
  assert.equal(((await anon.req('GET', `/api/public/v1/jobs/${PLAIN}`)).json.data ?? {}).thresholdCondition, null);
  assert.equal((await mcpGetJob(COND_JOB))?.thresholdCondition, COND);
});

const cand = await candidate(`th-cand-${stamp}@example.test`);
await check('regular apply, no condition: accepted without any confirmation (as before)', async () => {
  const r = await cand.req('POST', `/api/jobs/apply/${PLAIN}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 200, r.text);
  if (db) {
    const row = (await db.query(`SELECT threshold_confirmed, threshold_confirmed_at FROM job_applications WHERE job_id = $1`, [PLAIN])).rows[0];
    assert.deepEqual([row.threshold_confirmed, row.threshold_confirmed_at], [false, null]);
  }
});

await check('regular apply with a condition: refused without the confirmation (400, the current text), and "true" or 1 do not count', async () => {
  const r = await cand.req('POST', `/api/jobs/apply/${COND_JOB}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, 'threshold_not_confirmed');
  assert.equal(r.json.thresholdCondition, COND);
  assert.ok(/תנאי הסף/.test(r.json.message), 'a Hebrew message');
  for (const v of ['true', 1, false]) {
    const x = await cand.req('POST', `/api/jobs/apply/${COND_JOB}`, { cv: { mode: 'profile' }, thresholdConfirmed: v });
    assert.equal(x.json?.code, 'threshold_not_confirmed', `thresholdConfirmed=${JSON.stringify(v)}`);
  }
  if (db) assert.equal((await db.query(`SELECT COUNT(*)::int n FROM job_applications WHERE job_id = $1`, [COND_JOB])).rows[0].n, 0, 'nothing stored');
});

await check('regular apply with a job-only CV: refused without confirming and the upload is NOT claimed; accepted with it', async () => {
  const c2 = await candidate(`th-cand2-${stamp}@example.test`);
  const t = crypto.randomUUID();
  assert.equal((await upload(c2, t, 'job_cv.pdf')).status, 200);
  const choice = { mode: 'jobOnly', cvFilePath: `${t}/job_cv.pdf` };
  const refused = await c2.req('POST', `/api/jobs/apply/${COND_JOB}`, { cv: choice });
  assert.equal(refused.json?.code, 'threshold_not_confirmed', refused.text);
  const ok = await c2.req('POST', `/api/jobs/apply/${COND_JOB}`, { cv: choice, thresholdConfirmed: true });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.data.cvScope, 'job', 'the same upload was still usable after the refusal');
});

await check('regular apply with a condition and the confirmation: accepted; stored = confirmed + time only', async () => {
  const r = await cand.req('POST', `/api/jobs/apply/${COND_JOB}`, { cv: { mode: 'profile' }, thresholdConfirmed: true });
  assert.equal(r.status, 200, r.text);
  if (db) {
    const rows = (await db.query(`SELECT threshold_confirmed, threshold_confirmed_at FROM job_applications WHERE job_id = $1`, [COND_JOB])).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.threshold_confirmed, true);
      assert.ok(row.threshold_confirmed_at instanceof Date && Date.now() - row.threshold_confirmed_at.getTime() < 10 * 60_000);
    }
  }
});

await check('quick (guest) apply: no condition → as before; with one → refused without, the CV upload kept; accepted with', async () => {
  assert.equal((await guestApply(PLAIN)).status, 200, 'no condition: accepted');
  const t = crypto.randomUUID();
  assert.equal((await upload(anon, t, 'guest_cv.pdf')).status, 200);
  const email = `th-guest-${stamp}@example.test`;
  const refused = await guestApply(COND_JOB, {}, { email, cvFilePath: `${t}/guest_cv.pdf` });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.code, 'threshold_not_confirmed');
  assert.equal(refused.json.thresholdCondition, COND);
  const ok = await guestApply(COND_JOB, { thresholdConfirmed: true }, { email, cvFilePath: `${t}/guest_cv.pdf` });
  assert.equal(ok.status, 200, ok.text);
  if (db) {
    const rows = (await db.query(`SELECT cv_key, threshold_confirmed, threshold_confirmed_at FROM guest_applications WHERE job_id = $1`, [COND_JOB])).rows;
    assert.equal(rows.length, 1, 'only the confirmed one was stored');
    assert.equal(rows[0].threshold_confirmed, true);
    assert.ok(rows[0].threshold_confirmed_at);
    assert.ok(rows[0].cv_key, 'the CV of the refused attempt reached the accepted one');
    const plain = (await db.query(`SELECT threshold_confirmed, threshold_confirmed_at FROM guest_applications WHERE job_id = $1`, [PLAIN])).rows[0];
    assert.deepEqual([plain.threshold_confirmed, plain.threshold_confirmed_at], [false, null]);
  }
});

await check('staff: change and clear it; a job without one is applied to as before again', async () => {
  const ch = await cm.req('PATCH', `/api/jobs/${COND_JOB}`, { thresholdCondition: 'רישיון עריכת דין בתוקף', status: 'Active' });
  assert.equal(ch.status, 200, ch.text);
  assert.equal((await anon.req('GET', `/api/jobs/${COND_JOB}`)).json.data.thresholdCondition, 'רישיון עריכת דין בתוקף');
  const g = await guestApply(COND_JOB);
  assert.equal(g.json?.thresholdCondition, 'רישיון עריכת דין בתוקף', 'the refusal carries the new text');
  const cl = await cm.req('PATCH', `/api/jobs/${COND_JOB}`, { thresholdCondition: '', status: 'Active' });
  assert.equal(cl.status, 200, cl.text);
  assert.equal((await anon.req('GET', `/api/jobs/${COND_JOB}`)).json.data.thresholdCondition, null);
  assert.equal((await guestApply(COND_JOB)).status, 200, 'no condition any more: accepted without');
});

// ---- employers ----
const subForm = (title, extra = {}) => ({
  title, companyName: 'חברת סף', citySymbol: 5000, jobScope: ['FullTime'], requiredSkills: [skillId],
  description: `תיאור ארוך מספיק של משרה לבדיקת תנאי הסף ${stamp}.`, externalLink: '', publicEmail: `apply-th-${stamp}@example.test`,
  contactName: 'דנה מעסיקה', contactEmail: `contact-th-${stamp}@example.test`, contactPhone: '050-1234567', consent: true, website: '', ...extra,
});
const approveByTitle = async (title) => {
  const list = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items;
  const s = list.find((x) => x.title === title);
  assert.ok(s, `submission ${title} listed`);
  const full = (await cm.req('GET', `/api/admin/job-submissions/${s.id}`)).json.data;
  const ap = await cm.req('POST', `/api/admin/job-submissions/${s.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  return { submission: full, jobId: ap.json.data.jobId };
};

await check('employer form (anonymous): "תנאי סף" validated, shown to staff, copied to the job on approval', async () => {
  const bad = await anon.req('POST', '/api/job-submissions', subForm(`E2E-THX-${stamp}`.slice(0, 30), { thresholdCondition: 'x'.repeat(501) }));
  assert.equal(bad.status, 400, bad.text);
  assert.equal(bad.json.fields?.thresholdCondition, 'too_long');
  const title = `E2E-THA-${stamp}`.slice(0, 30);
  const r = await anon.req('POST', '/api/job-submissions', subForm(title, { thresholdCondition: 'קורס <i>הנהלת חשבונות</i> סוג 2' }));
  assert.equal(r.status, 201, r.text);
  const { submission, jobId } = await approveByTitle(title);
  assert.equal(submission.thresholdCondition, 'קורס הנהלת חשבונות סוג 2');
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.thresholdCondition, 'קורס הנהלת חשבונות סוג 2');
});

await check('employer account: own job carries it; an edit request to change it stays pending until approved, then applies', async () => {
  const emp = jar();
  const email = `th-emp-${stamp}@example.test`;
  const code = await devCode(emp, email);
  assert.equal((await emp.req('POST', '/api/auth/email/verify', { email, code })).json?.data?.status, 'signup');
  const su = await emp.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה בע"מ', phone: `05${String(crypto.randomInt(1e7, 1e8))}`,
    jobTitle: 'מגייסת', consent: true, marketingConsent: false,
  });
  assert.equal(su.status, 200, su.text);
  const title = `E2E-THE-${stamp}`.slice(0, 30);
  assert.equal((await emp.req('POST', '/api/job-submissions', subForm(title, { thresholdCondition: 'ניסיון בשיווק' }))).status, 201);
  const { jobId } = await approveByTitle(title);
  const mine = (await emp.req('GET', `/api/employer/jobs/${jobId}`)).json.data;
  assert.equal(mine.values.thresholdCondition, 'ניסיון בשיווק');

  const tooLong = await emp.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { thresholdCondition: 'x'.repeat(600) });
  assert.equal(tooLong.status, 400);
  const er = await emp.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { thresholdCondition: 'רישיון רואה חשבון' });
  assert.equal(er.status, 201, er.text);
  assert.deepEqual(er.json.data.fields, ['thresholdCondition']);
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.thresholdCondition, 'ניסיון בשיווק', 'not live before approval');
  const detail = (await cm.req('GET', `/api/admin/job-edit-requests/${er.json.data.id}`)).json.data;
  const row = detail.comparison.find((c) => c.field === 'thresholdCondition');
  assert.deepEqual([row?.base, row?.current, row?.requested], ['ניסיון בשיווק', 'ניסיון בשיווק', 'רישיון רואה חשבון'], 'before/after view');
  const ap = await cm.req('POST', `/api/admin/job-edit-requests/${er.json.data.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.thresholdCondition, 'רישיון רואה חשבון', 'live after approval');
  // Clearing it is a change too.
  const clear = await emp.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { thresholdCondition: '' });
  assert.equal(clear.status, 201, clear.text);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${clear.json.data.id}/reject`, { reason: 'נשאר' })).status, 200);
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.thresholdCondition, 'רישיון רואה חשבון', 'a rejection keeps it');
});

await check('jobs imported from the existing site: none, a change to it refused (409), no application taken (409 job_on_existing_site)', async () => {
  await ensureImportedJob(); // with DATABASE_URL: seeds one on a fresh DB (helpers/localDb.mjs)
  const list = (await cm.req('GET', '/api/admin/jobs/with-comments')).json.data.jobs;
  const imported = list.find((j) => j.importedFromLive && !j.deletedAt && j.status === 'Active');
  if (!imported) throw skip('no active imported job on this DB: run with DATABASE_URL (seeds one) or after test/local-setup.mjs');
  assert.equal(imported.thresholdCondition, null);
  const r = await cm.req('PATCH', `/api/jobs/${imported._id}`, { thresholdCondition: 'ניסיון', status: imported.status });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'job_read_only');
  assert.equal((await anon.req('GET', `/api/jobs/${imported._id}`)).json.data.thresholdCondition, null);
  if (new Date(imported.publishDate) <= new Date()) {
    const c3 = await candidate(`th-cand3-${stamp}@example.test`);
    // Owner, 23.11.2026: the existing site's jobs take no applications here (jobs made here do: every check above).
    const a = await c3.req('POST', `/api/jobs/apply/${imported._id}`, { cv: { mode: 'profile' }, thresholdConfirmed: true });
    assert.equal(a.status, 409, a.text);
    assert.equal(a.json.code, 'job_on_existing_site');
    assert.equal((await anon.req('GET', `/api/jobs/${imported._id}`)).json.data.onExistingSite, true);
    const g = await guestApply(imported._id, { thresholdConfirmed: true });
    assert.equal(g.status, 409, g.text);
    assert.equal(g.json.code, 'job_on_existing_site');
  }
  if (db) assert.equal((await db.query(`SELECT threshold_condition FROM jobs WHERE id = $1`, [imported._id])).rows[0].threshold_condition, null);
});

await cm.req('PUT', '/api/admin/settings/apply-policy', originalDefaults);
if (db) await db.end();

for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? `\n      ${m}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${summary(results)}`);
process.exit(failed ? 1 : 0);
