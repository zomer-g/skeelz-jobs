// Employers see the applicants the SKEELZ team forwarded to them (docs/employers.md "Applicants") — tries to break it
// against a running LOCAL server on a FRESH dev DB (integrations off, EMAIL_CODE_SIGNIN_ENABLED=true, the mock SSO
// values from server/.env.example). Needs the DB for ageing timestamps, imported jobs, deactivation and log checks:
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://… node test/e2e-employer-applicants.mjs
// Covers: not forwarded → invisible (no count); another employer's job → 404; imported job → nothing; the 90-day
// window after the job stopped being active; name + CV only (no email/phone/ids anywhere); own limits → 429 + admin
// alert, never raised; every view and CV open logged strictly BEFORE the data leaves (a blocked log → 503, nothing
// sent); cancel only before the employer saw it; a deactivated employer refused; quick (guest) applications included.
// Uses 4 of the 5 employer-form submissions an IP may send per hour and ~13 of the 30 writes: restart the server first.
import assert from 'node:assert/strict';
import { ensureImportedJob, isSkip, skip, summary } from './helpers/localDb.mjs';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin } from './helpers/staffLogin.mjs';
import { devCode, signUp } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) {
  throw new Error('DATABASE_URL of the LOCAL dev database is required (ages timestamps, checks the log)');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const pg = (await import('pg')).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    snapshot: () => new Map(cookies),
    restore: (m) => { cookies.clear(); for (const [k, v] of m) cookies.set(k, v); },
    async req(method, path, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, buf, headers: res.headers };
    },
  };
};
const refused = (r) => r.status === 401 || r.status === 403 || (r.status === 400 && /^(Forbidden|Unauthorized|au\d+)$/.test(String(r.json?.code ?? '')));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push([isSkip(e) ? 'SKIP' : 'FAIL', name, e.message]); }
};

const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;
const pdfBytes = async (text) => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText(text);
  return Buffer.from(await doc.save());
};
const upload = async (client, token, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdfBytes('Test CV')], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
/** Every string in a JSON value, and every key. */
const walk = (v, out = { keys: new Set(), strings: [] }) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.keys.add(k); walk(x, out); }
  else if (typeof v === 'string') out.strings.push(v);
  return out;
};

const anon = jar(), cm = jar(), sec = jar();
const empA = jar(), empB = jar(), empC = jar();
const candX = jar(), candY = jar(), guest = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const EMP = { A: `apl-a-${stamp}@example.test`, B: `apl-b-${stamp}@example.test`, C: `apl-c-${stamp}@example.test` };
const X = { email: `apl-x-${stamp}@example.test`, phone: phone(), first: 'נועם', last: `איקס${'קקק'}` };
const Y = { email: `apl-y-${stamp}@example.test`, phone: phone(), first: 'יעל', last: 'וויי' };
const G = { email: `apl-g-${stamp}@example.test`, phone: phone(), name: `אורח מהיר ${stamp.slice(-4)}` };
const ids = { A: '', B: '', C: '', X: '', Y: '', G: '' };
const jobs = { A: '', B: '', C: '', I: '' };
/** Every answer an employer got in this run (checked at the end for anything personal). */
const employerAnswers = [];
const asEmployer = async (client, method, path, body) => {
  const r = await client.req(method, path, body);
  employerAnswers.push([`${method} ${path}`, r]);
  return r;
};
const listOf = async (client, q = '') => asEmployer(client, 'GET', `/api/employer/applicants${q}`);
const namesIn = (r) => (r.json?.data?.jobs ?? []).flatMap((j) => j.applicants.map((a) => a.name));
const applicantOf = (r, name) => (r.json?.data?.jobs ?? []).flatMap((j) => j.applicants).find((a) => a.name === name);
const staffRows = async (state = 'all') => {
  const r = await cm.req('GET', `/api/admin/employer-forwards?state=${state}&limit=100`);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
const rowOf = (rows, candidateId, jobId) => rows.items.find((x) => x.candidateId === candidateId && x.jobId === jobId);
const forward = (row) => cm.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId });
const form = (title) => ({
  title, companyName: 'חברת בדיקה', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
  description: `תיאור ארוך מספיק של משרה לבדיקת מועמדים למעסיקים ${stamp}.`,
  externalLink: '', publicEmail: `apply-${stamp}@example.test`,
  contactName: 'איש קשר', contactEmail: `contact-${stamp}@example.test`, contactPhone: '050-1234567', consent: true, website: '',
});
const employerSignUp = async (client, email) => {
  const code = await devCode(client, email);
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  assert.equal(v.json?.data?.status, 'signup', v.text);
  const r = await client.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: `חברה ${email.slice(4, 5)} ${stamp}`, phone: phone(),
    consent: true, marketingConsent: false,
  });
  assert.equal(r.status, 200, r.text);
  return r.json.data.user._id ?? r.json.data.user.id;
};
const candidateSignUp = async (client, p) => {
  const r = await signUp(client, {
    firstName: p.first, lastName: p.last, email: p.email, phoneNumber: p.phone, dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  return r.json.data._id;
};
const applyWithCv = async (client, jobId, name) => {
  const t = crypto.randomUUID();
  assert.equal((await upload(client, t, name)).status, 200, 'CV upload');
  const r = await client.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/${name}` } });
  assert.equal(r.status, 200, `apply: ${r.text}`);
};
const auditOf = async (action, actor) =>
  (await db.query(`SELECT id, at, actor, target, details FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR actor = $2) ORDER BY id`, [action, actor ?? null])).rows;

// ---------------------------------------------------------------------------
await check('setup: staff, three employers with one approved job each, candidates and a quick application', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(sec, ADMIN_EMAIL)).status, 200);
  ids.A = await employerSignUp(empA, EMP.A);
  ids.B = await employerSignUp(empB, EMP.B);
  ids.C = await employerSignUp(empC, EMP.C);
  for (const k of ['A', 'B', 'C']) {
    const client = { A: empA, B: empB, C: empC }[k];
    const r = await client.req('POST', '/api/job-submissions', form(`APL-${k}-${stamp}`.slice(0, 30)));
    assert.equal(r.status, 201, r.text);
  }
  const list = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items;
  for (const k of ['A', 'B', 'C']) {
    const s = list.find((x) => x.title === `APL-${k}-${stamp}`.slice(0, 30));
    const ap = await cm.req('POST', `/api/admin/job-submissions/${s.id}/approve`, {});
    assert.equal(ap.status, 200, ap.text);
    jobs[k] = ap.json.data.jobId;
  }
  // Quick apply open on A's job.
  const p = await cm.req('PATCH', `/api/jobs/${jobs.A}`, { guestModeOverride: 'quick', status: 'Active' });
  assert.equal(p.status, 200, p.text);
  ids.X = await candidateSignUp(candX, X);
  ids.Y = await candidateSignUp(candY, Y);
  await applyWithCv(candX, jobs.A, `noam_${X.phone}.pdf`); // the stored file name carries personal data on purpose
  await applyWithCv(candX, jobs.B, 'x_b.pdf');
  const ya = await candY.req('POST', `/api/jobs/apply/${jobs.A}`, { cv: { mode: 'profile' } });
  assert.equal(ya.status, 200, ya.text);
  const yc = await candY.req('POST', `/api/jobs/apply/${jobs.C}`, { cv: { mode: 'profile' } });
  assert.equal(yc.status, 200, yc.text);
  const t = crypto.randomUUID();
  assert.equal((await upload(guest, t, 'guest_cv.pdf')).status, 200);
  const g = await guest.req('POST', '/api/jobs/guestApply', {
    consent: true, jobData: { _id: jobs.A }, guestData: { fullName: G.name, email: G.email, phoneNumber: G.phone, cvFilePath: `${t}/guest_cv.pdf` },
  });
  assert.equal(g.status, 200, g.text);
  ids.G = (await db.query(`SELECT id FROM guest_applications WHERE job_id = $1 AND email = lower($2)`, [jobs.A, G.email])).rows[0]?.id;
  assert.ok(ids.G, 'the quick application is stored');
});

await check('not forwarded → invisible: an empty list, no count anywhere in the employer\'s area', async () => {
  const r = await listOf(empA);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data, { jobs: [], cut: 0 });
  const one = await listOf(empA, `?jobId=${jobs.A}`);
  assert.deepEqual(one.json.data, { jobs: [], cut: 0 }, 'own job: nothing either');
  for (const p of ['/api/employer/jobs', `/api/employer/jobs/${jobs.A}`, '/api/employer/me', '/api/auth/session']) {
    const x = await asEmployer(empA, 'GET', p);
    const { keys } = walk(x.json);
    for (const k of ['applicants', 'applications', 'applicationsCount', 'count', 'forwards', 'pending']) assert.ok(!keys.has(k), `${p} has ${k}`);
  }
});

await check('staff: "ממתינות להעברה" lists registered + quick applications by employer and job; imported jobs never', async () => {
  const d = await staffRows('pending');
  assert.ok(rowOf(d, ids.X, jobs.A) && rowOf(d, ids.Y, jobs.A) && rowOf(d, ids.G, jobs.A) && rowOf(d, ids.X, jobs.B) && rowOf(d, ids.Y, jobs.C));
  const g = rowOf(d, ids.G, jobs.A);
  assert.equal(g.kind, 'guest');
  assert.equal(g.employer.id, ids.A);
  assert.equal(g.state, 'pending');
  assert.ok(g.forwardable);
  assert.ok(d.pending >= 5);
  // Logged as a staff hand-over with the ids shown.
  const e = (await auditOf('candidates.shown', CM_EMAIL)).filter((x) => x.target === 'GET /api/admin/employer-forwards').pop();
  assert.ok(e && e.details.ids.includes(ids.G) && e.details.ids.includes(ids.X), 'staff list logged with the ids');
  // The quick-applications screen carries the forward state for jobs of employer accounts.
  const ga = await cm.req('GET', `/api/admin/guest-applications?jobId=${jobs.A}`);
  const row = ga.json.data.applications.find((a) => a.id === ids.G);
  assert.deepEqual(row.employerForward, { employerJob: true, forwardId: null, state: 'pending', forwardable: true });
});

let fwdX = '', fwdG = '';
await check('forward X (registered) and G (quick): A sees exactly those two — name, forward date, CV flag; nothing else', async () => {
  const d = await staffRows('pending');
  const fx = await forward(rowOf(d, ids.X, jobs.A));
  assert.equal(fx.status, 201, fx.text); fwdX = fx.json.data.id;
  const fg = await forward(rowOf(d, ids.G, jobs.A));
  assert.equal(fg.status, 201, fg.text); fwdG = fg.json.data.id;
  const r = await listOf(empA);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(namesIn(r).sort(), [`${X.first} ${X.last}`, G.name].sort());
  // Exact shapes: nothing beyond the job, the name, the forward date and whether there is a CV.
  assert.deepEqual(Object.keys(r.json.data).sort(), ['cut', 'jobs']);
  const job = r.json.data.jobs[0];
  assert.deepEqual(Object.keys(job).sort(), ['accessUntil', 'active', 'applicants', 'jobId', 'jobNumber', 'title']);
  assert.equal(job.jobId, jobs.A); assert.equal(job.active, true); assert.equal(job.accessUntil, null);
  for (const a of job.applicants) {
    assert.deepEqual(Object.keys(a).sort(), ['forwardId', 'forwardedAt', 'hasCv', 'name']);
    assert.ok(a.hasCv);
    assert.ok(a.forwardId !== ids.X && a.forwardId !== ids.G, 'the handle is the forward id, not the candidate id');
  }
  // B and C see nothing (B's own application of X is not forwarded).
  assert.deepEqual((await listOf(empB)).json.data.jobs, []);
  assert.deepEqual((await listOf(empC)).json.data.jobs, []);
  // The forward is logged with ids only.
  const f = (await auditOf('employer.applicant_forwarded', CM_EMAIL)).find((x) => x.target === fwdX);
  assert.ok(f, 'forward logged');
  assert.deepEqual(f.details.ids, [ids.X]);
  assert.equal(f.details.employer, `user:${ids.A}`);
});

await check('another employer\'s job / forward → 404 (B on A\'s job, A on B\'s, junk ids); a duplicate forward → 409', async () => {
  for (const [c, q] of [[empB, `?jobId=${jobs.A}`], [empA, `?jobId=${jobs.B}`], [empA, `?jobId=${ids.X}`], [empA, '?jobId=1'], [empA, `?jobId=${encodeURIComponent("' OR 1=1 --")}`]]) {
    const r = await listOf(c, q);
    assert.equal(r.status, 404, `${q}: ${r.status}`);
    assert.ok(!r.text.includes(X.first) && !r.text.includes(G.name));
  }
  for (const id of [fwdX, fwdG, ids.X, ids.G, '0'.repeat(24), '../../users']) {
    const r = await asEmployer(empB, 'GET', `/api/employer/applicants/${encodeURIComponent(id)}/cv`);
    assert.equal(r.status, 404, `B CV ${id}: ${r.status}`);
    assert.ok(!r.buf.subarray(0, 4).toString().startsWith('%PDF'));
  }
  const d = await staffRows('forwarded');
  assert.equal((await forward(rowOf(d, ids.X, jobs.A))).json.code, 'already_forwarded');
});

await check('CV: A opens X\'s and G\'s CV (a neutral file name); every open logged strictly with the candidate id', async () => {
  const before = (await auditOf('employer.cv_opened', `user:${ids.A}`)).length;
  const list = await listOf(empA);
  for (const name of [`${X.first} ${X.last}`, G.name]) {
    const a = applicantOf(list, name);
    const r = await asEmployer(empA, 'GET', `/api/employer/applicants/${a.forwardId}/cv`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.buf.subarray(0, 4).toString().startsWith('%PDF'), 'a PDF');
    assert.match(r.headers.get('content-disposition') || '', /filename="cv\.pdf"/);
    assert.ok(!(r.headers.get('content-disposition') || '').includes(X.phone), 'the stored name is not sent');
  }
  const after = await auditOf('employer.cv_opened', `user:${ids.A}`);
  assert.equal(after.length, before + 2);
  assert.deepEqual(after.slice(-2).map((e) => e.target).sort(), [ids.X, ids.G].sort());
  const shown = (await auditOf('employer.applicants_shown', `user:${ids.A}`)).pop();
  assert.ok(shown.details.ids.includes(ids.X) && shown.details.ids.includes(ids.G), 'the list entry carries the ids shown');
});

await check('strict log: when the log refuses the entry, the employer gets no list and no CV (503)', async () => {
  await db.query(`CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action IN ('employer.applicants_shown','employer.cv_opened') THEN RAISE EXCEPTION 'blocked by test'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER test_block_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_block_audit()`);
  try {
    const l = await listOf(empA);
    assert.equal(l.status, 503, l.text);
    assert.equal(l.json.data, undefined);
    assert.ok(!l.text.includes(X.first) && !l.text.includes(G.name), 'no name in the refusal');
    const c = await asEmployer(empA, 'GET', `/api/employer/applicants/${fwdX}/cv`);
    assert.equal(c.status, 503);
    assert.ok(!c.buf.subarray(0, 4).toString().startsWith('%PDF'), 'the file was not sent');
  } finally {
    await db.query(`DROP TRIGGER IF EXISTS test_block_audit ON audit_log`);
    await db.query(`DROP FUNCTION IF EXISTS test_block_audit()`);
  }
});

await check('cancel: works before the employer saw it (and it disappears); refused after (409, logged); seen is final', async () => {
  let d = await staffRows('pending');
  const fy = await forward(rowOf(d, ids.Y, jobs.A));
  assert.equal(fy.status, 201, fy.text);
  const c = await cm.req('POST', `/api/admin/employer-forwards/${fy.json.data.id}/cancel`, {});
  assert.equal(c.status, 200, c.text);
  assert.ok(!namesIn(await listOf(empA)).includes(`${Y.first} ${Y.last}`), 'a cancelled forward is never shown');
  assert.equal((await cm.req('POST', `/api/admin/employer-forwards/${fy.json.data.id}/cancel`, {})).json.code, 'forward_cancelled');
  assert.ok((await auditOf('employer.forward_cancelled', CM_EMAIL)).some((e) => e.target === fy.json.data.id));
  // Forward again → the employer sees it → it can't be cancelled any more.
  d = await staffRows('pending');
  const again = await forward(rowOf(d, ids.Y, jobs.A));
  assert.equal(again.status, 201, again.text);
  assert.ok(namesIn(await listOf(empA)).includes(`${Y.first} ${Y.last}`));
  const late = await cm.req('POST', `/api/admin/employer-forwards/${again.json.data.id}/cancel`, {});
  assert.equal(late.status, 409, late.text);
  assert.equal(late.json.code, 'forward_seen');
  assert.ok((await auditOf('employer.forward_cancel_refused', CM_EMAIL)).some((e) => e.target === again.json.data.id));
  assert.ok(namesIn(await listOf(empA)).includes(`${Y.first} ${Y.last}`), 'still shown');
  // The DB refuses too: no delete, no un-seeing, no cancel after seen, identity fixed.
  // (Simple queries with the hex ids inline: a failing parameterized query desyncs the local PGlite socket.)
  const fid = again.json.data.id;
  assert.match(fid, /^[a-f0-9]{24}$/); assert.match(ids.B, /^[a-f0-9]{24}$/);
  await assert.rejects(db.query(`DELETE FROM employer_forwards WHERE id = '${fid}'`), /never deleted/);
  await assert.rejects(db.query(`UPDATE employer_forwards SET cancelled_at = now() WHERE id = '${fid}'`), /already saw/);
  await assert.rejects(db.query(`UPDATE employer_forwards SET employer_user_id = '${ids.B}' WHERE id = '${fid}'`), /cannot be changed/);
  const st = rowOf(await staffRows('forwarded'), ids.Y, jobs.A);
  assert.equal(st.state, 'seen');
});

await check('imported job: no owner → can\'t be forwarded, and a forced link/forward is never shown', async () => {
  jobs.I = await ensureImportedJob(); // seeds one on a fresh DB (helpers/localDb.mjs)
  const appId = crypto.randomBytes(12).toString('hex');
  // An application from before (the DB now refuses new ones to the existing site's jobs: job_applications_legacy_guard).
  await db.query(`SET session_replication_role = replica`);
  try { await db.query(`INSERT INTO job_applications (id, user_id, job_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [appId, ids.X, jobs.I]); }
  finally { await db.query(`SET session_replication_role = DEFAULT`); }
  const app = (await db.query(`SELECT id FROM job_applications WHERE user_id = $1 AND job_id = $2`, [ids.X, jobs.I])).rows[0].id;
  // Even if a link to an employer existed by mistake:
  await db.query(`INSERT INTO employer_jobs (job_id, user_id, via) VALUES ($1, $2, 'claim') ON CONFLICT DO NOTHING`, [jobs.I, ids.A]);
  try {
    const f = await cm.req('POST', '/api/admin/employer-forwards', { kind: 'application', applicationId: app });
    assert.equal(f.status, 409, f.text);
    assert.equal(f.json.code, 'no_employer');
    assert.ok(!(await staffRows('all')).items.some((x) => x.jobId === jobs.I), 'not on the staff screen either');
    const forced = crypto.randomBytes(12).toString('hex');
    await db.query(`INSERT INTO employer_forwards (id, kind, application_id, candidate_id, job_id, employer_user_id, forwarded_by)
                    VALUES ($1, 'application', $2, $3, $4, $5, 'test')`, [forced, app, ids.X, jobs.I, ids.A]);
    assert.ok(!(await listOf(empA)).json.data.jobs.some((j) => j.jobId === jobs.I), 'an imported job never shows applicants');
    assert.equal((await listOf(empA, `?jobId=${jobs.I}`)).status, 404);
    assert.equal((await asEmployer(empA, 'GET', `/api/employer/applicants/${forced}/cv`)).status, 404);
    await db.query(`UPDATE employer_forwards SET cancelled_at = now(), cancelled_by = 'test' WHERE id = $1`, [forced]);
  } finally {
    await db.query(`DELETE FROM employer_jobs WHERE job_id = $1 AND user_id = $2`, [jobs.I, ids.A]);
  }
});

await check('window: closed → still shown with "until"; aged past 90 days → gone (CV 404, no new forwards); nothing deleted; active again → back', async () => {
  const close = await cm.req('PATCH', `/api/jobs/${jobs.A}`, { status: 'Closed' });
  assert.equal(close.status, 200, close.text);
  const since = (await db.query(`SELECT since FROM job_inactive_since WHERE job_id = $1`, [jobs.A])).rows[0]?.since;
  assert.ok(since && Math.abs(new Date(since).getTime() - Date.now()) < 120_000, 'the moment the job stopped being active is stored');
  let r = await listOf(empA);
  const j = r.json.data.jobs.find((x) => x.jobId === jobs.A);
  assert.ok(j, 'still shown inside the window');
  assert.equal(j.active, false);
  const days = (new Date(j.accessUntil).getTime() - new Date(since).getTime()) / 86400_000;
  assert.ok(Math.abs(days - 90) < 0.01, `until = closed + 90 days (${days})`);
  // 89 days ago: still in.
  await db.query(`UPDATE job_inactive_since SET since = now() - interval '89 days' WHERE job_id = $1`, [jobs.A]);
  assert.ok((await listOf(empA)).json.data.jobs.some((x) => x.jobId === jobs.A), '89 days: still shown');
  // 91 days ago: gone.
  await db.query(`UPDATE job_inactive_since SET since = now() - interval '91 days' WHERE job_id = $1`, [jobs.A]);
  r = await listOf(empA);
  assert.ok(!r.json.data.jobs.some((x) => x.jobId === jobs.A), 'past the window: gone');
  assert.equal((await asEmployer(empA, 'GET', `/api/employer/applicants/${fwdX}/cv`)).status, 404, 'CV gone too');
  const all = await staffRows('all');
  const gx = rowOf(all, ids.X, jobs.A);
  assert.ok(gx && gx.state === 'seen' && gx.accessOpen === false, 'staff still see it (nothing deleted)');
  const forwards = (await db.query(`SELECT count(*)::int AS n FROM employer_forwards WHERE job_id = $1`, [jobs.A])).rows[0].n;
  assert.ok(forwards >= 3, 'the forwards are kept');
  // A pending application of this job can't be forwarded any more.
  await db.query(`INSERT INTO guest_applications (id, application_id, job_id, full_name, email, phone_number)
                  VALUES ($1, $2, $3, 'אורח מאוחר', $4, $5)`, [crypto.randomBytes(12).toString('hex'), crypto.randomBytes(12).toString('hex'), jobs.A, `late-${stamp}@example.test`, phone()]);
  const late = (await staffRows('all')).items.find((x) => x.jobId === jobs.A && x.name === 'אורח מאוחר');
  assert.ok(late && !late.forwardable);
  assert.equal((await forward(late)).json.code, 'window_closed');
  assert.ok(!(await staffRows('pending')).items.some((x) => x.jobId === jobs.A), 'not in "ממתינות להעברה"');
  // Active again → shown again (the moment is cleared).
  assert.equal((await cm.req('PATCH', `/api/jobs/${jobs.A}`, { status: 'Active' })).status, 200);
  assert.equal((await db.query(`SELECT since FROM job_inactive_since WHERE job_id = $1`, [jobs.A])).rows[0].since, null);
  assert.ok((await listOf(empA)).json.data.jobs.some((x) => x.jobId === jobs.A), 'active again: back');
  // Removing from the board (archive) also starts the window.
  assert.equal((await cm.req('POST', `/api/admin/jobs/${jobs.B}/archive`, {})).status, 200);
  assert.ok((await db.query(`SELECT since FROM job_inactive_since WHERE job_id = $1`, [jobs.B])).rows[0]?.since, 'archive → since set');
});

await check('limits: the employer\'s own people budget → 429 + admin alert; never raised by a grant', async () => {
  const d = await staffRows('pending');
  assert.equal((await forward(rowOf(d, ids.Y, jobs.C))).status, 201);
  // Fill C's budget to the line (the log is the counter; inserts are allowed, changes are not).
  await db.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, 'employer.applicants_shown', 'test-fill', $2)`,
    [`user:${ids.C}`, JSON.stringify({ count: 200, ids: [] })]);
  const r = await listOf(empC);
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.code, 'limit_employerPeople');
  assert.ok(!r.text.includes(Y.first), 'no name in the refusal');
  const alert = (await db.query(`SELECT kind FROM security_alerts WHERE user_email = $1`, [`user:${ids.C}`])).rows.map((x) => x.kind);
  assert.ok(alert.includes('employerPeople_limit'), `alert raised (${alert})`);
  const s = await sec.req('GET', '/api/admin/security');
  assert.ok(s.json.data.alerts.some((a) => a.kind === 'employerPeople_limit' && a.user_email === `user:${ids.C}`), 'admins see it');
  assert.ok(s.json.data.employerUsage.some((u) => u.actor === `user:${ids.C}` && u.people.used >= 200), 'usage on the security screen');
  const g = await sec.req('POST', '/api/admin/security/grant', { email: `user:${ids.C}`, budget: 'employerPeople' });
  assert.equal(g.status, 400, `no grants for employers: ${g.text}`);
  assert.equal((await listOf(empC)).status, 429, 'still refused');
  assert.ok((await auditOf('limits.refused', `user:${ids.C}`)).length >= 1, 'the refusal is logged');
});

await check('limits: the employer\'s CV budget → 429 + alert at the line; the alert threshold raises a "many" alert', async () => {
  await db.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, 'employer.cv_opened', 'test-fill', $2)`,
    [`user:${ids.C}`, JSON.stringify({ count: 30, ids: [] })]);
  const r = await asEmployer(empC, 'GET', `/api/employer/applicants/${'a'.repeat(24)}/cv`);
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.code, 'limit_employerCvs');
  assert.ok((await db.query(`SELECT 1 FROM security_alerts WHERE user_email = $1 AND kind = 'employerCvs_limit'`, [`user:${ids.C}`])).rowCount);
  // A: 13 opened so far today + 2 earlier in this run = 15 → crosses the alert line (15) on the next open.
  const used = (await db.query(`SELECT COALESCE(SUM((details->>'count')::int), 0)::int AS n FROM audit_log WHERE actor = $1 AND action = 'employer.cv_opened'`, [`user:${ids.A}`])).rows[0].n;
  await db.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, 'employer.cv_opened', 'test-fill', $2)`,
    [`user:${ids.A}`, JSON.stringify({ count: 14 - used, ids: [] })]);
  assert.equal((await asEmployer(empA, 'GET', `/api/employer/applicants/${fwdG}/cv`)).status, 200);
  assert.ok((await db.query(`SELECT 1 FROM security_alerts WHERE user_email = $1 AND kind = 'employerCvs_many' AND threshold = 15`, [`user:${ids.A}`])).rowCount, 'alert at 15');
  // Staff budgets are separate: the content manager's own usage is untouched by employers.
  const s = await sec.req('GET', '/api/admin/security');
  assert.ok(!s.json.data.usage.some((u) => u.actor.startsWith('user:')), 'employers are not in the staff usage');
});

await check('deactivated employer: refused at once on the same session; staff can\'t forward to them', async () => {
  // Fresh pending application to B's job (X's application to B was never forwarded).
  const snap = empB.snapshot();
  await db.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [ids.B]);
  try {
    const r = await empB.req('GET', '/api/employer/applicants');
    assert.ok(refused(r), `deactivated: ${r.status}`);
    empB.restore(snap);
    const c = await empB.req('GET', `/api/employer/applicants/${fwdX}/cv`);
    assert.ok(refused(c), `deactivated CV: ${c.status}`);
    const row = rowOf(await staffRows('all'), ids.X, jobs.B);
    assert.equal(row.employer.active, false);
    assert.equal(row.forwardable, false);
    assert.equal((await forward(row)).json.code, 'employer_inactive');
  } finally {
    await db.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [ids.B]);
  }
});

await check('nothing personal beyond name + CV in ANY employer answer: no email, phone, city, candidate or application id', async () => {
  const appIds = (await db.query(`SELECT id FROM job_applications WHERE user_id = ANY($1)`, [[ids.X, ids.Y]])).rows.map((x) => x.id);
  const cityName = String(city.cityName ?? city.name ?? '');
  for (const [p, r] of employerAnswers) {
    if (/\/cv$/.test(p) && r.status === 200) continue; // the CV file itself
    const text = r.text;
    for (const bad of [X.email, Y.email, G.email, X.phone, Y.phone, G.phone, ids.X, ids.Y, ids.G, ...appIds, CM_EMAIL, ADMIN_EMAIL]) {
      assert.ok(!text.includes(bad), `${p} carries a forbidden value`);
    }
    if (cityName.length > 2 && /applicants/.test(p)) assert.ok(!text.includes(cityName), `${p} carries the city`);
    const { keys } = walk(r.json);
    for (const k of ['email', 'phone', 'phoneNumber', 'citySymbol', 'city', 'gender', 'dateOfBirth', 'skills', 'candidateId', 'applicationId', 'userId', 'cvFileUrl', 'cvKey']) {
      if (/\/api\/(employer\/(me|jobs)|auth\/session)/.test(p)) continue; // the employer's own record / job form
      assert.ok(!keys.has(k), `${p} has key ${k}`);
    }
  }
  assert.ok(employerAnswers.length > 30, `answers checked (${employerAnswers.length})`);
});

await check('the log: employer views carry ids only; "who saw X" finds the employer; audit details have no names or contacts', async () => {
  const who = await sec.req('GET', `/api/admin/audit?subject=${ids.X}`);
  assert.equal(who.status, 200);
  const actions = who.json.data.entries.map((e) => `${e.actor} ${e.action}`);
  assert.ok(actions.includes(`user:${ids.A} employer.applicants_shown`) && actions.includes(`user:${ids.A} employer.cv_opened`), 'the employer is found by the candidate');
  assert.ok(actions.some((a) => a.endsWith('employer.applicant_forwarded')), 'the forward too');
  const rows = (await db.query(`SELECT action, details FROM audit_log WHERE action LIKE 'employer.%' OR action = 'limits.refused'`)).rows;
  for (const e of rows) {
    const d = JSON.stringify(e.details ?? {});
    for (const bad of [X.email, Y.email, G.email, X.phone, Y.phone, G.phone, X.first, Y.first, G.name, X.last]) {
      assert.ok(!d.includes(bad), `${e.action} details carry personal data`);
    }
  }
});

// ---- adversarial review (11.2026): bypass attempts beyond the checks above ----------------------------------

await check('strict log refused on a CV open: nothing sent AND the forward stays unseen (still cancellable)', async () => {
  // A fresh quick application with a CV on A's job (the same stored file as G's), forwarded, never listed.
  const gid = crypto.randomBytes(12).toString('hex');
  const cvKey = (await db.query(`SELECT cv_key FROM guest_applications WHERE id = $1`, [ids.G])).rows[0].cv_key;
  await db.query(`INSERT INTO guest_applications (id, application_id, job_id, full_name, email, phone_number, cv_key)
                  VALUES ($1, $2, $3, 'אורח יומן', $4, $5, $6)`, [gid, crypto.randomBytes(12).toString('hex'), jobs.A, `log-${stamp}@example.test`, phone(), cvKey]);
  const row = (await staffRows('pending')).items.find((x) => x.applicationId === gid);
  assert.ok(row, 'waiting to be forwarded');
  const f = await forward(row);
  assert.equal(f.status, 201, f.text);
  const fid = f.json.data.id;
  await db.query(`CREATE OR REPLACE FUNCTION test_block_cv() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'employer.cv_opened' THEN RAISE EXCEPTION 'blocked by test'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER test_block_cv BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_block_cv()`);
  try {
    const c = await asEmployer(empA, 'GET', `/api/employer/applicants/${fid}/cv`);
    assert.equal(c.status, 503, c.text);
    assert.ok(!c.buf.subarray(0, 4).toString().startsWith('%PDF'), 'the file was not sent');
  } finally {
    await db.query(`DROP TRIGGER IF EXISTS test_block_cv ON audit_log`);
    await db.query(`DROP FUNCTION IF EXISTS test_block_cv()`);
  }
  const seen = (await db.query(`SELECT first_seen_at FROM employer_forwards WHERE id = '${fid}'`)).rows[0].first_seen_at;
  assert.equal(seen, null, 'not marked seen: the employer saw nothing');
  const cancel = await cm.req('POST', `/api/admin/employer-forwards/${fid}/cancel`, {});
  assert.equal(cancel.status, 200, `still cancellable: ${cancel.text}`);
});

await check('CV 404s are identical: another employer\'s forward, a cancelled one, one without a CV, a junk id', async () => {
  const otherF = (await db.query(`SELECT id FROM employer_forwards WHERE employer_user_id = '${ids.C}' AND cancelled_at IS NULL LIMIT 1`)).rows[0]?.id;
  const cancelledF = (await db.query(`SELECT id FROM employer_forwards WHERE employer_user_id = '${ids.A}' AND cancelled_at IS NOT NULL LIMIT 1`)).rows[0]?.id;
  const late = (await staffRows('pending')).items.find((x) => x.jobId === jobs.A && x.name === 'אורח מאוחר');
  assert.ok(otherF && cancelledF && late, 'fixtures');
  const nf = await forward(late); // a quick application without a CV
  assert.equal(nf.status, 201, nf.text);
  const bodies = [];
  for (const id of [otherF, cancelledF, nf.json.data.id, 'f'.repeat(24)]) {
    const r = await asEmployer(empA, 'GET', `/api/employer/applicants/${id}/cv`);
    assert.equal(r.status, 404, `${id}: ${r.status}`);
    bodies.push(r.text);
  }
  assert.equal(new Set(bodies).size, 1, `the same answer every time: ${[...new Set(bodies)].join(' | ')}`);
  // Probing marks nothing seen.
  assert.equal((await db.query(`SELECT first_seen_at FROM employer_forwards WHERE id = '${nf.json.data.id}'`)).rows[0].first_seen_at, null);
});

await check('CV answer headers: neutral name, nosniff, sandboxed, no-store; nothing of the stored file name', async () => {
  const r = await asEmployer(empA, 'GET', `/api/employer/applicants/${fwdX}/cv`); // X's file is noam_<phone>.pdf
  assert.equal(r.status, 200, r.text.slice(0, 80));
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="cv.pdf"');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
  assert.match(r.headers.get('cache-control') || '', /no-store/);
  const all = [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
  for (const bad of [X.phone, 'noam', X.email, ids.X]) assert.ok(!all.includes(bad), 'a header carries the candidate');
});

await check('one owner per job: a job can\'t be linked to a second employer (DB key), so a forward can\'t follow it', async () => {
  assert.match(jobs.A, /^[a-f0-9]{24}$/);
  await assert.rejects(db.query(`INSERT INTO employer_jobs (job_id, user_id, via) VALUES ('${jobs.A}', '${ids.B}', 'claim')`), /duplicate|unique/i);
  assert.equal((await db.query(`SELECT user_id FROM employer_jobs WHERE job_id = '${jobs.A}'`)).rows[0].user_id, ids.A);
});

await check('claim of an earlier submission: the job becomes the claimant\'s, its applicants still need a forward', async () => {
  const T = `APL-CL-${stamp}`.slice(0, 30);
  const s = await anon.req('POST', '/api/job-submissions', { ...form(T), contactEmail: EMP.C });
  assert.equal(s.status, 201, s.text);
  const sub = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items.find((x) => x.title === T);
  const ap = await cm.req('POST', `/api/admin/job-submissions/${sub.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  const J = ap.json.data.jobId;
  assert.equal((await candY.req('POST', `/api/jobs/apply/${J}`, { cv: { mode: 'profile' } })).status, 200);
  assert.ok(!(await staffRows('all')).items.some((x) => x.jobId === J), 'no owner yet → nothing to forward');
  const c = await empC.req('POST', '/api/employer/submissions/claim', {});
  assert.equal(c.status, 200, c.text);
  assert.ok(c.json.data.jobs >= 1, 'the job came with the claim');
  const row = rowOf(await staffRows('pending'), ids.Y, J);
  assert.ok(row && row.employer.id === ids.C, 'now waiting to be forwarded to the claimant');
  const l = await listOf(empC, `?jobId=${J}`);
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(l.json.data.jobs, [], 'claiming shows no applicant by itself');
  // Another employer can't claim it (not their verified email) nor list it.
  assert.equal((await empA.req('POST', '/api/employer/submissions/claim', {})).json.data.claimed, 0);
  assert.equal((await listOf(empA, `?jobId=${J}`)).status, 404);
});

await check('the inactive moment through every staff path: board status, archive/restore, an approved edit request', async () => {
  const sinceOf = async () => (await db.query(`SELECT since FROM job_inactive_since WHERE job_id = '${jobs.C}'`)).rows[0]?.since ?? null;
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${jobs.C}/board`, { status: 'Closed' })).status, 200);
  assert.ok(await sinceOf(), 'board → Closed: set');
  await db.query(`UPDATE job_inactive_since SET since = now() - interval '80 days' WHERE job_id = '${jobs.C}'`);
  const old = new Date(await sinceOf()).getTime();
  const same = async (what) => assert.equal(new Date(await sinceOf()).getTime(), old, `${what}: the moment is not moved (the window is not extended)`);
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${jobs.C}/board`, { status: 'Suspended' })).status, 200);
  await same('Closed → Suspended');
  const er = await empC.req('POST', `/api/employer/jobs/${jobs.C}/edit-requests`, { title: `APL-C2-${stamp}`.slice(0, 30) });
  assert.equal(er.status, 201, er.text);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${er.json.data.id}/approve`, {})).status, 200);
  await same('edit request approved');
  assert.equal((await cm.req('POST', `/api/admin/jobs/${jobs.C}/archive`, {})).status, 200);
  await same('archived while inactive');
  assert.equal((await cm.req('POST', `/api/admin/jobs/${jobs.C}/restore`, {})).status, 200);
  await same('restored but still suspended');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${jobs.C}/board`, { status: 'Active' })).status, 200);
  assert.equal(await sinceOf(), null, 'active again: cleared (the forwards are visible again)');
});

await check('a candidate can\'t forge, list or cancel forwards, and gets no employer route', async () => {
  for (const [m, p] of [['POST', '/api/admin/employer-forwards'], ['GET', '/api/admin/employer-forwards'],
    ['POST', `/api/admin/employer-forwards/${fwdX}/cancel`], ['GET', '/api/employer/applicants'], ['GET', `/api/employer/applicants/${fwdX}/cv`]]) {
    const snap = candX.snapshot();
    const r = await candX.req(m, p, m === 'POST' ? { kind: 'application', applicationId: 'a'.repeat(24) } : undefined);
    assert.ok(refused(r), `candidate ${m} ${p}: ${r.status}`);
    assert.ok(!r.text.includes(G.name) && !r.text.includes(Y.last));
    candX.restore(snap);
  }
});

await db.end();
for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${summary(results)}`);
process.exit(failed ? 1 : 0);
