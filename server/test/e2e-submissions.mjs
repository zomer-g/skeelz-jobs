// End-to-end checks of the employer job form against a running LOCAL server (fresh dev DB, integrations off).
//   BASE=http://localhost:3100 CM_EMAIL=... CM_PASSWORD=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/e2e-submissions.mjs
// Staff sign in only with "Continue with Google" (xhostd SSO): start the server with the mock values in helpers/staffLogin.mjs.
// Review is the content manager's (`admin` jar below); the activity log is read by the admin (`sec`).
// Uses up the per-IP submission budget (5/hour) — the last check expects 429. Never point this at production.
import assert from 'node:assert/strict';
import { staffLogin } from './helpers/staffLogin.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password-123';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const CM_PASSWORD = process.env.CM_PASSWORD || 'dev-content-password-123';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

const anon = jar();
const admin = jar();
const stamp = Date.now().toString(36);
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const form = (title) => ({
  title, companyName: 'חברת בדיקה', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
  description: `תיאור ארוך מספיק של משרה לבדיקה ${stamp}.\n\n<script>alert(1)</script> <b>bold</b>`,
  externalLink: '', publicEmail: `jobs-${stamp}@example.test`,
  contactName: 'דנה בדיקה', contactEmail: `dana-${stamp}@example.test`, contactPhone: '050-1234567', consent: true, website: '',
});
const T1 = `E2E-A-${stamp}`.slice(0, 30);
const T2 = `E2E-R-${stamp}`.slice(0, 30);
const T1b = `E2E-A2-${stamp}`.slice(0, 30);
const publicHas = async (title) => {
  const list = (await anon.req('GET', '/api/jobs/active')).json.data.jobs;
  const page = (await anon.req('GET', '/')).text;
  return list.some((j) => j.title === title) || page.includes(title);
};

const sec = jar();
await check('content manager and admin log in', async () => {
  assert.equal((await staffLogin(admin, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(sec, ADMIN_EMAIL)).status, 200);
});
const pendingBefore = (await admin.req('GET', '/api/admin/job-submissions')).json?.data?.counts?.pending ?? 0;

await check('honeypot: answered like a success, nothing stored', async () => {
  const r = await anon.req('POST', '/api/job-submissions', { ...form(`E2E-H-${stamp}`), website: 'http://spam.example' });
  assert.equal(r.status, 201);
  assert.equal((await admin.req('GET', '/api/admin/job-submissions')).json.data.counts.pending, pendingBefore);
});

await check('invalid submission is refused with field codes (no consent, bad email)', async () => {
  const r = await anon.req('POST', '/api/job-submissions', { ...form('x'), consent: false, contactEmail: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.json.fields.consent, 'required');
  assert.equal(r.json.fields.contactEmail, 'invalid');
  assert.equal(r.json.fields.title, 'too_short');
});

await check('valid submissions are accepted (201)', async () => {
  assert.equal((await anon.req('POST', '/api/job-submissions', form(T1))).status, 201);
  assert.equal((await anon.req('POST', '/api/job-submissions', form(T2))).status, 201);
});

await check('pending submissions are not public (board, page data, job routes)', async () => {
  assert.equal(await publicHas(T1), false);
  assert.equal(await publicHas(T2), false);
});

await check('anonymous cannot list, open, approve or reject submissions', async () => {
  for (const [m, p] of [['GET', '/api/admin/job-submissions'], ['GET', '/api/admin/job-submissions/000000000000000000000000'],
    ['POST', '/api/admin/job-submissions/000000000000000000000000/approve'], ['POST', '/api/admin/job-submissions/000000000000000000000000/reject'],
    ['PATCH', '/api/admin/job-submissions/000000000000000000000000']]) {
    const r = await anon.req(m, p, m === 'GET' ? undefined : {});
    // The gate refuses like everywhere else in this API (see e2e.mjs): not 2xx, code au2 (not signed in).
    assert.ok(r.status >= 400 && r.json?.code === 'au2', `${m} ${p} → ${r.status} ${r.json?.code}`);
  }
});

let idA, idR;
await check('staff list: pending, without contact details', async () => {
  const d = (await admin.req('GET', '/api/admin/job-submissions?status=pending')).json.data;
  idA = d.items.find((s) => s.title === T1)?.id;
  idR = d.items.find((s) => s.title === T2)?.id;
  assert.ok(idA && idR, 'submissions not in the pending list');
  assert.ok(!JSON.stringify(d).includes(`dana-${stamp}`), 'contact email in the list');
});

await check('staff open one: contact details, description stored as plain text', async () => {
  const s = (await admin.req('GET', `/api/admin/job-submissions/${idA}`)).json.data;
  assert.equal(s.contactEmail, `dana-${stamp}@example.test`);
  assert.equal(s.status, 'pending');
  assert.ok(s.description.includes('<script>'), 'kept as typed text');
});

await check('staff edit (validated; only while pending)', async () => {
  assert.equal((await admin.req('PATCH', `/api/admin/job-submissions/${idA}`, { title: 'x' })).status, 400);
  const r = await admin.req('PATCH', `/api/admin/job-submissions/${idA}`, { title: T1b });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.title, T1b);
});

let jobId;
await check('approve publishes the job (board + job page); description escaped', async () => {
  const r = await admin.req('POST', `/api/admin/job-submissions/${idA}/approve`, {});
  assert.equal(r.status, 200, r.text);
  jobId = r.json.data.jobId;
  assert.equal(await publicHas(T1b), true);
  const job = (await anon.req('GET', `/api/jobs/${jobId}`)).json.data;
  assert.equal(job.title, T1b);
  assert.equal(job.contactPersonEmail, `jobs-${stamp}@example.test`); // the public apply email, not the private contact
  assert.ok(!job.description.includes('<script') && !job.description.includes('<b>'), job.description);
  assert.ok(job.description.includes('&lt;script&gt;'));
  assert.ok(!JSON.stringify(job).includes(`dana-${stamp}`), 'private contact leaked into the job');
});

await check('approve twice → 409, no second job', async () => {
  assert.equal((await admin.req('POST', `/api/admin/job-submissions/${idA}/approve`, {})).status, 409);
  const list = (await anon.req('GET', '/api/jobs/active')).json.data.jobs;
  assert.equal(list.filter((j) => j.title === T1b).length, 1);
});

await check('reject with a reason: stays private, cannot be approved after', async () => {
  const r = await admin.req('POST', `/api/admin/job-submissions/${idR}/reject`, { reason: 'לא מתאים' });
  assert.equal(r.status, 200);
  assert.equal((await admin.req('POST', `/api/admin/job-submissions/${idR}/approve`, {})).status, 409);
  assert.equal((await admin.req('PATCH', `/api/admin/job-submissions/${idR}`, { title: 'abc' })).status, 409);
  assert.equal(await publicHas(T2), false);
  const s = (await admin.req('GET', `/api/admin/job-submissions/${idR}`)).json.data;
  assert.equal(s.status, 'rejected');
  assert.equal(s.rejectReason, 'לא מתאים');
});

await check('activity log: submitted / viewed / edited / approved / rejected, no contact values', async () => {
  const entries = (await sec.req('GET', '/api/admin/audit?action=jobs.')).json.data.entries;
  const actions = new Set(entries.map((e) => e.action));
  for (const a of ['jobs.submitted', 'jobs.submission_dropped', 'jobs.submissions_listed', 'jobs.submission_viewed',
    'jobs.submission_edited', 'jobs.submission_approved', 'jobs.submission_rejected']) assert.ok(actions.has(a), `${a} missing`);
  const s = JSON.stringify(entries);
  assert.ok(!s.includes(`dana-${stamp}`) && !s.includes('050-1234567') && !s.includes('לא מתאים'), 'personal data or reason text in the log');
  const edited = entries.find((e) => e.action === 'jobs.submission_edited' && e.target === idA);
  assert.deepEqual(edited.details.fields, ['title']);
});

await check('per-IP rate limit (5 an hour) → 429', async () => {
  let last;
  for (let i = 0; i < 3; i++) last = await anon.req('POST', '/api/job-submissions', { website: 'x' });
  assert.equal(last.status, 429);
});

for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
