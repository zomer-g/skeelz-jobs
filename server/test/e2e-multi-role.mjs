// Several roles per account (owner, 23.11.2026: "a user can be a candidate, an employer and a content manager / admin
// at once"), against a running LOCAL server (fresh dev DB, integrations off, EMAIL_CODE_SIGNIN_ENABLED=true, the mock
// SSO values from server/.env.example) and its DB:
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://… node test/e2e-multi-role.mjs
// One person P becomes candidate → + employer (from inside the account) → + content manager (admin, staff screen),
// and each role keeps its own rules:
// - staff powers only on a Google (xhostd SSO) session; an emailed-code session of the same account is candidate +
//   employer only (staff routes refused);
// - as staff, P sees candidates only through the hand-over (strict log, P's staff budget, by email);
// - as employer, P sees ONLY applicants forwarded to P's own job (name + CV flag), on one employer budget owned by the
//   account (user:<id>) whatever the session, separate from the staff budget;
// - as candidate, P has the personal area and applies;
// - removing the staff role keeps candidate + employer; an employer-only account becomes a candidate too;
// - a staff-only account still gets no code; no route adds a staff role to oneself; every addition is logged (role only).
// Uses 1 of the per-IP employer-form submissions: restart the server first if the per-IP limits were spent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin, xhostdSignIn, signedInOk } from './helpers/staffLogin.mjs';
import { devCode, signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the suite reads roles and consent rows)');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const pg = (await import('pg')).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    clear: () => cookies.clear(),
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
const upload = async (client, token, name) => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Test CV');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await doc.save())], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
const anon = jar(), cm = jar(), sec = jar();
const pCode = jar(), pGoogle = jar(), candX = jar(), empE = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const P = `multi-p-${stamp}@example.test`;
const X = `multi-x-${stamp}@example.test`;
const E = `multi-e-${stamp}@example.test`;
const ids = { P: '', X: '', E: '' };
let jobId = '';
const candidateBody = (email, first, last) => ({
  firstName: first, lastName: last, email, phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z',
  gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
});
const employerBody = { firstName: 'דנה', lastName: 'רבת', companyName: `רב תפקידים ${stamp}`.slice(0, 40), phone: phone(), jobTitle: 'מגייסת', consent: true, marketingConsent: false };
const rolesOf = async (id) => [...(await db.query(`SELECT roles FROM users WHERE id = $1`, [id])).rows[0].roles].sort();
const session = async (client) => (await client.req('GET', '/api/auth/session')).json?.data?.user ?? null;
const audit = async (action, where = '') => (await db.query(`SELECT actor, target, details FROM audit_log WHERE action = $1 ${where} ORDER BY id`, [action])).rows;

// ---------------------------------------------------------------------------
await check('setup: staff sign in; P and X sign up as candidates', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(sec, ADMIN_EMAIL)).status, 200);
  const p = await signUp(pCode, candidateBody(P, 'פלוני', 'רב'));
  assert.equal(p.status, 200, p.text);
  ids.P = p.json.data._id;
  const x = await signUp(candX, candidateBody(X, 'איקס', 'מועמד'));
  assert.equal(x.status, 200, x.text);
  ids.X = x.json.data._id;
  assert.deepEqual(await rolesOf(ids.P), ['user']);
});

await check('candidate → + employer from inside the account: same email and sign-in, consent recorded, logged (role only)', async () => {
  assert.ok(refused(await pCode.req('GET', '/api/employer/me')), 'not an employer yet');
  // The refusal signed the session out (as every gate does): sign in again by code.
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  const bad = await pCode.req('POST', '/api/users/me/roles/employer', { ...employerBody, consent: false });
  assert.equal(bad.status, 400, bad.text);
  assert.deepEqual(await rolesOf(ids.P), ['user'], 'nothing changed without consent');
  const r = await pCode.req('POST', '/api/users/me/roles/employer', employerBody);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await rolesOf(ids.P), ['employer', 'user']);
  assert.equal((await pCode.req('POST', '/api/users/me/roles/employer', employerBody)).json?.code, 'role_already_held');
  const s = await session(pCode);
  assert.deepEqual([...s.roles].sort(), ['employer', 'user']);
  assert.equal(s.email, P);
  assert.equal(s.employer?.companyName, employerBody.companyName);
  assert.equal((await pCode.req('GET', '/api/users/me')).status, 200, 'still a candidate');
  assert.equal((await pCode.req('GET', '/api/employer/me')).status, 200, 'now an employer');
  const c = await db.query(`SELECT 1 FROM consent_records WHERE subject_id = $1 AND source = 'employer_role_added'`, [ids.P]);
  assert.equal(c.rowCount, 1, 'the consent on that form is kept');
  const log = await audit('auth.role_added', `AND target = '${ids.P}'`);
  assert.equal(log.length, 1);
  assert.equal(log[0].details.role, 'employer');
  assert.ok(!JSON.stringify(log[0]).includes('@'), 'no address in the entry');
});

await check('no route adds a staff role to oneself', async () => {
  for (const r of ['admin', 'content_manager', 'placement_coordinator', 'staff']) {
    const a = await pCode.req('POST', `/api/users/me/roles/${r}`, {});
    assert.ok(a.status === 404 || refused(a), `${r}: ${a.status}`);
  }
  assert.deepEqual(await rolesOf(ids.P), ['employer', 'user']);
  assert.equal((await candidateLogin(pCode, P)).status, 200);
});

await check('admin adds content manager to P (staff screen): roles kept, flags shown, change logged with roles before / after', async () => {
  const add = await sec.req('POST', '/api/admin/staff', { email: P, role: 'content_manager' });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.json.data.created, false);
  assert.ok(add.json.data.alsoCandidate && add.json.data.alsoEmployer, add.text);
  assert.deepEqual(await rolesOf(ids.P), ['content_manager', 'employer', 'user']);
  assert.equal((await db.query(`SELECT role FROM users WHERE id = $1`, [ids.P])).rows[0].role, 'content_manager', 'role = the highest');
  const row = (await sec.req('GET', '/api/admin/staff')).json.data.staff.find((s) => s.id === ids.P);
  assert.ok(row && row.role === 'content_manager' && row.alsoCandidate && row.alsoEmployer, JSON.stringify(row));
  const log = (await audit('staff.role_changed', `AND target = '${P}'`)).at(-1);
  assert.deepEqual([...log.details.roles_after].sort(), ['content_manager', 'employer', 'user']);
  assert.deepEqual([...log.details.roles_before].sort(), ['employer', 'user']);
});

await check('an emailed-code session of P carries candidate + employer only: staff routes refused', async () => {
  // The role change closed P's sessions; a code is still sent (P holds non-staff roles).
  assert.ok(refused(await pCode.req('GET', '/api/users/me')), 'old session closed by the role change');
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  const s = await session(pCode);
  assert.deepEqual([...s.roles].sort(), ['employer', 'user'], 'no staff role on a code session');
  assert.equal((await pCode.req('GET', '/api/users/me')).status, 200);
  assert.equal((await pCode.req('GET', '/api/employer/me')).status, 200);
  for (const path of ['/api/users?page=1&limit=9', '/api/admin/job-submissions', '/api/admin/employer-forwards?state=all']) {
    const r = await pCode.req('GET', path);
    assert.ok(refused(r), `${path}: ${r.status}`);
    assert.equal((await candidateLogin(pCode, P)).status, 200); // each refusal signs out
  }
  const denied = await audit('access.denied', `AND actor = 'user:${ids.P}'`);
  assert.ok(denied.some((d) => String(d.details?.reason ?? '').startsWith('role:')), 'refusals logged with the session roles');
});

await check('a Google session of P carries all three: staff sees candidates through the hand-over (by email, staff budget)', async () => {
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)), 'P signs in with Google');
  const s = await session(pGoogle);
  assert.deepEqual([...s.roles].sort(), ['content_manager', 'employer', 'user']);
  assert.equal(s.role, 'content_manager');
  const list = await pGoogle.req('GET', `/api/users?page=1&limit=9&inputValue=${encodeURIComponent(X)}`);
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.data.users.some((u) => u._id === ids.X), 'X is listed');
  const shown = (await audit('candidates.shown', `AND actor = '${P}'`)).at(-1);
  assert.ok(shown && shown.details.ids.includes(ids.X), 'strict entry with the ids shown, actor = P by email');
  assert.equal((await pGoogle.req('GET', '/api/users/me')).status, 200, 'the candidate area on the same session');
  assert.equal((await pGoogle.req('GET', '/api/employer/me')).status, 200, 'the employer area on the same session');
  // The admin-only areas stay closed to a content manager.
  assert.ok(refused(await pGoogle.req('GET', '/api/admin/security')));
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)), 'sign in again after the refusal');
});

await check('as employer P sees ONLY applicants forwarded to P\'s own job — not X, whom P sees as staff', async () => {
  const sub = await pGoogle.req('POST', '/api/job-submissions', {
    title: `MR-${stamp}`.slice(0, 28), companyName: 'רב תפקידים', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
    description: `תיאור ארוך מספיק של משרה לבדיקת חשבון עם כמה תפקידים ${stamp}.`, externalLink: '', publicEmail: `apply-${stamp}@example.test`,
    contactName: 'דנה רבת', contactEmail: P, contactPhone: '050-1234567', consent: true, website: '',
  });
  assert.equal(sub.status, 201, sub.text);
  const item = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items.find((x) => x.title === `MR-${stamp}`.slice(0, 28));
  // Security review 24.11.2026, L3: P (content manager) never approves P's own employer account's submission.
  const own = await pGoogle.req('POST', `/api/admin/job-submissions/${item.id}/approve`, {});
  assert.equal(own.status, 403, own.text);
  assert.equal(own.json.code, 'own_employer_account');
  const ap = await cm.req('POST', `/api/admin/job-submissions/${item.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  jobId = ap.json.data.jobId;
  assert.ok((await pGoogle.req('GET', '/api/employer/jobs')).json.data.items.some((j) => j.id === jobId), 'the job is P\'s (sent while signed in)');
  const t = crypto.randomUUID();
  assert.equal((await upload(candX, t, 'x.pdf')).status, 200);
  assert.equal((await candX.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/x.pdf` } })).status, 200);
  const before = await pGoogle.req('GET', '/api/employer/applicants');
  assert.equal(before.status, 200, before.text);
  assert.deepEqual(before.json.data.jobs, [], 'nothing forwarded → nothing, although P sees X as staff');
});

await check('after a forward: name + CV flag only; one employer budget owned by the account on every session', async () => {
  const rows = (await cm.req('GET', '/api/admin/employer-forwards?state=pending&limit=100')).json.data.items;
  const row = rows.find((r) => r.candidateId === ids.X && r.jobId === jobId);
  assert.ok(row, 'X\'s application is forwardable to P');
  // L3: nor forwards candidates to P's own employer account.
  const self = await pGoogle.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId });
  assert.equal(self.status, 403, self.text);
  assert.equal(self.json.code, 'own_employer_account');
  assert.equal((await cm.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId })).status, 201);
  const g = await pGoogle.req('GET', '/api/employer/applicants');
  assert.equal(g.status, 200, g.text);
  const a = g.json.data.jobs.flatMap((j) => j.applicants);
  assert.equal(a.length, 1);
  assert.deepEqual(Object.keys(a[0]).sort(), ['forwardId', 'forwardedAt', 'hasCv', 'name']);
  assert.ok(!g.text.includes(X), 'no email of the applicant');
  // A refused route signs every session of the account out (as before): the code session signs in again.
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  const c = await pCode.req('GET', '/api/employer/applicants');
  assert.equal(c.status, 200, c.text);
  const shown = await audit('employer.applicants_shown', `AND (actor = '${P}' OR actor = 'user:${ids.P}')`);
  const google = shown.find((e) => e.actor === P);
  const code = shown.find((e) => e.actor === `user:${ids.P}`);
  assert.ok(google && code, 'both sessions logged');
  assert.equal(google.details.budget_owner, `user:${ids.P}`, 'the Google session spends the account\'s employer budget');
  const s = (await sec.req('GET', '/api/admin/security')).json.data;
  assert.ok(s.employerUsage.some((u) => u.actor === `user:${ids.P}` && u.people.used >= 1), JSON.stringify(s.employerUsage));
  assert.ok(!s.employerUsage.some((u) => u.actor === P), 'no second employer budget under the email');
  assert.ok(s.usage.some((u) => u.actor === P && u.people.used >= 1), 'the staff budget is P\'s email, separate');
});

await check('as candidate P applies like anyone (Google session)', async () => {
  const t = crypto.randomUUID();
  assert.equal((await upload(pGoogle, t, 'p.pdf')).status, 200);
  const r = await pGoogle.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/p.pdf` } });
  assert.equal(r.status, 200, r.text);
  // The upload of a signed-in uploader names them (here by email: a Google session of staff).
  assert.ok((await audit('cv.uploaded', `AND actor = '${P}'`)).length >= 1);
  assert.equal((await pGoogle.req('GET', '/api/users/me')).status, 200);
});

await check('removing the staff role keeps candidate + employer; the staff routes close at once', async () => {
  assert.equal((await sec.req('PATCH', `/api/admin/staff/${ids.P}/role`, { role: 'user' })).status, 200);
  assert.deepEqual(await rolesOf(ids.P), ['employer', 'user']);
  assert.ok(refused(await pGoogle.req('GET', '/api/users?page=1&limit=9')));
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)));
  const s = await session(pGoogle);
  assert.deepEqual([...s.roles].sort(), ['employer', 'user']);
  assert.ok(refused(await pGoogle.req('GET', '/api/users?page=1&limit=9')), 'no staff role any more');
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  assert.equal((await pCode.req('GET', '/api/employer/me')).status, 200);
  assert.ok(!(await sec.req('GET', '/api/admin/staff')).json.data.staff.some((x) => x.id === ids.P), 'off the staff list');
});

await check('employer-only → + candidate from inside the account (sign-up fields + consent); logged', async () => {
  const code = await devCode(empE, E);
  assert.equal((await empE.req('POST', '/api/auth/email/verify', { email: E, code })).json.data.status, 'signup');
  const r = await empE.req('POST', '/api/auth/email/signup', { accountType: 'employer', ...employerBody, phone: phone() });
  assert.equal(r.status, 200, r.text);
  ids.E = r.json.data.user._id ?? r.json.data.user.id;
  const missing = await empE.req('POST', '/api/users/me/roles/candidate', { firstName: 'רק', consent: true });
  assert.equal(missing.status, 400, missing.text);
  assert.deepEqual(await rolesOf(ids.E), ['employer']);
  const add = await empE.req('POST', '/api/users/me/roles/candidate', { ...candidateBody(E, 'אלה', 'מעסיקה'), email: 'other@example.test' });
  assert.equal(add.status, 200, add.text);
  assert.deepEqual(await rolesOf(ids.E), ['employer', 'user']);
  assert.equal((await db.query(`SELECT email FROM users WHERE id = $1`, [ids.E])).rows[0].email, E, 'the email never comes from the body');
  assert.equal((await empE.req('GET', '/api/users/me')).status, 200);
  assert.equal((await empE.req('GET', '/api/employer/me')).status, 200);
  assert.equal((await db.query(`SELECT 1 FROM consent_records WHERE subject_id = $1 AND source = 'candidate_role_added'`, [ids.E])).rowCount, 1);
  const log = await audit('auth.role_added', `AND target = '${ids.E}'`);
  assert.equal(log.length, 1);
  assert.equal(log[0].details.role, 'user');
  // A candidate role already held: 409, nothing changed.
  assert.equal((await empE.req('POST', '/api/users/me/roles/candidate', candidateBody(E, 'אלה', 'מעסיקה'))).json?.code, 'role_already_held');
});

await check('a staff-only account still signs in only with Google (no code)', async () => {
  const r = await jar().req('POST', '/api/dev/email-code', { email: CM_EMAIL });
  assert.equal(r.status, 403, r.text);
});

await db.end();
for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? `  ${e}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
