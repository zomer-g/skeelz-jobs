// Owner's decisions of 24.11.2026, against a running LOCAL server (fresh dev DB, integrations off,
// EMAIL_CODE_SIGNIN_ENABLED=true, the mock SSO values from server/.env.example) and its DB:
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://… node test/e2e-role-blocks.mjs
// 1. Blocking a role, one by one (admins only; docs/security.md "Blocking a role"): candidate / employer / staff.
//    A block closes every session of the account at once; the person signs in again with the roles still open (Google,
//    code by email); with nothing open no sign-in works (logged); a blocked role can't be added back by the person;
//    a blocked employer receives no forwards; unblocking opens it again. Lock-out: no admin blocks their own staff role.
// 2. Employers ask to change EVERY field of their job (docs/employers.md "Edit requests"): the job's public contact, its
//    status and apply settings and all the added job fields — nothing reaches the board before staff approve; apply
//    settings (like a threshold condition) only by a content manager (403 content_manager_required for a coordinator);
//    a staff-only added field is write-only for the employer (its answer is never shown back, never compared).
// Uses 1 of the per-IP employer-form submissions: restart the server first if the per-IP limits were spent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin, xhostdSignIn, signedInOk, signInError } from './helpers/staffLogin.mjs';
import { devCode, signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (the suite reads roles, blocks and the log)');
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
const anon = jar(), cm = jar(), sec = jar(), co = jar();
const pCode = jar(), pGoogle = jar(), empE = jar(), candX = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const P = `blocks-p-${stamp}@example.test`;
const E = `blocks-e-${stamp}@example.test`;
const X = `blocks-x-${stamp}@example.test`;
const CO = `blocks-co-${stamp}@example.test`;
const ids = { P: '', E: '', X: '', admin: '' };
let jobId = '';
let PUBLIC_F = '', HIDDEN_F = '';
const candidateBody = (email, first, last) => ({
  firstName: first, lastName: last, email, phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z',
  gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
});
const employerBody = () => ({ firstName: 'דנה', lastName: 'חוסמת', companyName: `חסימות ${stamp}`.slice(0, 40), phone: phone(), jobTitle: 'מגייסת', consent: true, marketingConsent: false });
const blocksOf = async (id) => [...(await db.query(`SELECT blocked_roles FROM users WHERE id = $1`, [id])).rows[0].blocked_roles].sort();
const rolesOf = async (id) => [...(await db.query(`SELECT roles FROM users WHERE id = $1`, [id])).rows[0].roles].sort();
const session = async (client) => (await client.req('GET', '/api/auth/session')).json?.data?.user ?? null;
const audit = async (action, where = '', params = []) =>
  (await db.query(`SELECT actor, target, details FROM audit_log WHERE action = $1 ${where} ORDER BY id`, [action, ...params])).rows;
const block = (id, role, blocked, c = sec) => c.req('PUT', `/api/admin/role-blocks/${id}/${role}`, { blocked });

// ---------------------------------------------------------------------------
await check('setup: staff sign in; P is candidate + employer + content manager; E an employer with a job; X a candidate who applied', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  const a = await staffLogin(sec, ADMIN_EMAIL);
  assert.equal(a.status, 200);
  ids.admin = a.json.data.user._id ?? a.json.data.user.id;
  const p = await signUp(pCode, candidateBody(P, 'פלוני', 'חסום'));
  assert.equal(p.status, 200, p.text);
  ids.P = p.json.data._id;
  assert.equal((await pCode.req('POST', '/api/users/me/roles/employer', employerBody())).status, 200);
  assert.equal((await sec.req('POST', '/api/admin/staff', { email: P, role: 'content_manager' })).status, 200);
  assert.deepEqual(await rolesOf(ids.P), ['content_manager', 'employer', 'user']);
  // E: an employer account (sign-up by code), sends a job while signed in; the content manager approves it.
  const code = await devCode(empE, E);
  assert.equal((await empE.req('POST', '/api/auth/email/verify', { email: E, code })).json.data.status, 'signup');
  const r = await empE.req('POST', '/api/auth/email/signup', { accountType: 'employer', ...employerBody() });
  assert.equal(r.status, 200, r.text);
  ids.E = r.json.data.user._id ?? r.json.data.user.id;
  // Two added job fields (settings screen): one shown on the job page, one for staff only.
  const f1 = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'job', label: `שכר ${stamp}`, type: 'text', showOnJobPage: true });
  assert.equal(f1.status, 201, f1.text);
  PUBLIC_F = f1.json.data.field.id;
  const f2 = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'job', label: `הערת צוות ${stamp}`, type: 'text' });
  assert.equal(f2.status, 201, f2.text);
  HIDDEN_F = f2.json.data.field.id;
  const sub = await empE.req('POST', '/api/job-submissions', {
    title: `RB-${stamp}`.slice(0, 28), companyName: 'חסימות בע"מ', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
    description: `תיאור ארוך מספיק של משרה לבדיקת חסימות ועריכת כל השדות ${stamp}.`, externalLink: '', publicEmail: `apply-${stamp}@example.test`,
    contactName: 'דנה חוסמת', contactEmail: E, contactPhone: '050-1234567', consent: true, website: '',
  });
  assert.equal(sub.status, 201, sub.text);
  const item = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items.find((x) => x.title === `RB-${stamp}`.slice(0, 28));
  const ap = await cm.req('POST', `/api/admin/job-submissions/${item.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  jobId = ap.json.data.jobId;
  // Staff keep a note in the staff-only field (the employer must never see it).
  await db.query(`UPDATE jobs SET custom_fields = jsonb_set(COALESCE(custom_fields, '{}'::jsonb), $2, to_jsonb($3::text)) WHERE id = $1`,
    [jobId, `{${HIDDEN_F}}`, `staff-secret-${stamp}`]);
  const x = await signUp(candX, candidateBody(X, 'איקס', 'מגיש'));
  assert.equal(x.status, 200, x.text);
  ids.X = x.json.data._id;
  const t = crypto.randomUUID();
  assert.equal((await upload(candX, t, 'x.pdf')).status, 200);
  assert.equal((await candX.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/x.pdf` } })).status, 200);
  assert.equal((await sec.req('POST', '/api/admin/staff', { email: CO, role: 'placement_coordinator' })).status, 200);
  assert.ok(signedInOk(await xhostdSignIn(co, CO)), 'coordinator signs in with Google');
});

await check('only admins: content managers, coordinators, candidates and employers are refused; bad input', async () => {
  for (const [c, who, again] of [[cm, 'content manager', () => staffLogin(cm, CM_EMAIL)], [co, 'coordinator', () => xhostdSignIn(co, CO)],
    [candX, 'candidate', () => candidateLogin(candX, X)], [empE, 'employer', () => candidateLogin(empE, E)]]) {
    for (const [m, p, b] of [['GET', `/api/admin/role-blocks?email=${encodeURIComponent(P)}`], ['GET', `/api/admin/role-blocks/${ids.P}`],
      ['PUT', `/api/admin/role-blocks/${ids.P}/employer`, { blocked: true }]]) {
      const r = await c.req(m, p, b);
      assert.ok(refused(r), `${who} ${m} ${p}: ${r.status}`);
      await again(); // a refused gate signs the session out (as every gate does)
    }
  }
  assert.deepEqual(await blocksOf(ids.P), [], 'nothing changed');
  assert.equal((await block(ids.P, 'admin', true)).json?.code, 'bad_role');
  assert.equal((await sec.req('PUT', `/api/admin/role-blocks/${ids.P}/employer`, { blocked: 'yes' })).json?.code, 'bad_value');
  assert.equal((await block('000000000000000000000000', 'user', true)).status, 404);
  assert.equal((await sec.req('GET', `/api/admin/role-blocks?email=${encodeURIComponent(`nobody-${stamp}@example.test`)}`)).status, 404);
});

await check('the admin finds P by email: the kinds of role held and no blocks; nothing else about P; logged', async () => {
  const r = await sec.req('GET', `/api/admin/role-blocks?email=${encodeURIComponent(P.toUpperCase())}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data, { id: ids.P, roles: ['user', 'employer', 'staff'], staffRole: 'content_manager', blocked: [], active: true });
  assert.ok(!r.text.includes('@') && !r.text.includes('פלוני'), 'no email or name in the answer');
  assert.ok((await audit('users.role_blocks_viewed', `AND target = $2`, [ids.P])).some((e) => e.details.by === 'email'));
});

await check('blocking the employer role: every session of P closed at once; P signs in again as candidate (+ staff on Google) only', async () => {
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)));
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  assert.equal((await pCode.req('GET', '/api/employer/me')).status, 200, 'an employer before');
  const r = await block(ids.P, 'employer', true);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.blocked, ['employer']);
  assert.deepEqual(await blocksOf(ids.P), ['employer']);
  assert.deepEqual(await rolesOf(ids.P), ['content_manager', 'employer', 'user'], 'the role (and its data) stays on the account');
  for (const [c, n] of [[pCode, 'code'], [pGoogle, 'google']]) {
    const s = await c.req('GET', '/api/users/me');
    assert.ok(refused(s), `${n} session closed: ${s.status}`);
    assert.equal(await session(c), null, `${n}: no session`);
  }
  assert.equal((await candidateLogin(pCode, P)).status, 200, 'P signs in again by code');
  assert.deepEqual([...(await session(pCode)).roles].sort(), ['user'], 'a code session: candidate only now');
  assert.equal((await pCode.req('GET', '/api/users/me')).status, 200);
  assert.ok(refused(await pCode.req('GET', '/api/employer/me')), 'the employer area is closed');
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)), 'and with Google');
  assert.deepEqual([...(await session(pGoogle)).roles].sort(), ['content_manager', 'user']);
  assert.equal((await pGoogle.req('GET', '/api/admin/job-submissions')).status, 200, 'staff still works');
  const log = (await audit('users.role_blocked', `AND target = $2`, [ids.P])).at(-1);
  assert.equal(log.actor, ADMIN_EMAIL);
  assert.equal(log.details.role, 'employer');
  assert.equal(log.details.sessions_closed, true);
  assert.deepEqual(log.details.roles, ['user', 'employer', 'staff']);
  assert.ok(!JSON.stringify(log.details).includes('@'), 'no address in the details');
});

await check('a blocked role is not added back by the person (403 role_blocked); the staff list shows the block', async () => {
  assert.equal((await candidateLogin(pCode, P)).status, 200);
  const r = await pCode.req('POST', '/api/users/me/roles/employer', employerBody());
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'role_blocked');
  assert.deepEqual(await blocksOf(ids.P), ['employer']);
  const row = (await sec.req('GET', '/api/admin/staff')).json.data.staff.find((s) => s.id === ids.P);
  assert.deepEqual(row.blocked, ['employer']);
});

await check('blocking the staff role: Google gives candidate only; no admin blocks their own staff role', async () => {
  assert.equal((await block(ids.P, 'staff', true)).status, 200);
  assert.ok(refused(await pGoogle.req('GET', '/api/admin/job-submissions')), 'the Google session is closed');
  assert.equal(await session(pGoogle), null, 'no session left');
  assert.ok(signedInOk(await xhostdSignIn(pGoogle, P)), 'P still signs in with Google (as a candidate)');
  assert.deepEqual([...(await session(pGoogle)).roles], ['user']);
  assert.ok(refused(await pGoogle.req('GET', '/api/admin/job-submissions')), 'no staff powers');
  const self = await block(ids.admin, 'staff', true);
  assert.equal(self.status, 409, self.text);
  assert.equal(self.json.code, 'self_staff');
  assert.deepEqual(await blocksOf(ids.admin), []);
});

await check('all three blocked: no sign-in at all (Google, code) — neutral answers, refusals logged; unblocking the candidate role lets P in as a candidate', async () => {
  assert.equal((await block(ids.P, 'user', true)).status, 200);
  assert.deepEqual(await blocksOf(ids.P), ['employer', 'staff', 'user']);
  const g = await xhostdSignIn(pGoogle, P);
  assert.ok(!signedInOk(g), 'Google refused');
  assert.equal(signInError(g), 'failed');
  assert.equal(await session(pGoogle), null);
  assert.ok((await audit('auth.login_refused_blocked', `AND details->>'account' = $2`, [`user:${ids.P}`])).length >= 1, 'logged');
  const req = await anon.req('POST', '/api/auth/email/request', { email: P });
  assert.equal(req.status, 200, 'the same neutral answer as for anyone');
  assert.ok((await audit('auth.email_code_refused_blocked', `AND target = $2`, [`user:${ids.P}`])).length >= 1, 'no code sent, logged');
  const c = await candidateLogin(pCode, P);
  assert.notEqual(c.status, 200, 'a code (even a dev one) gives no session');
  assert.equal(await session(pCode), null);
  assert.equal((await block(ids.P, 'user', false)).status, 200);
  assert.ok((await audit('users.role_unblocked', `AND target = $2`, [ids.P])).some((e) => e.details.role === 'user' && e.details.sessions_closed === false));
  assert.equal((await candidateLogin(pCode, P)).status, 200, 'in again as a candidate');
  assert.deepEqual([...(await session(pCode)).roles], ['user']);
});

await check('a blocked employer receives no forwards and can\'t sign in (employer only); unblocked → both work again', async () => {
  const rows = () => cm.req('GET', '/api/admin/employer-forwards?state=all&limit=100');
  const row = (await rows()).json.data.items.find((r) => r.candidateId === ids.X && r.jobId === jobId);
  assert.ok(row && row.forwardable, 'forwardable before');
  assert.equal((await block(ids.E, 'employer', true)).status, 200);
  const after = (await rows()).json.data.items.find((r) => r.applicationId === row.applicationId);
  assert.equal(after.forwardable, false);
  assert.equal(after.employer.active, false);
  const f = await cm.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId });
  assert.equal(f.status, 409, f.text);
  assert.equal(f.json.code, 'employer_inactive');
  assert.ok(refused(await empE.req('GET', '/api/employer/me')), 'E\'s session closed');
  assert.notEqual((await candidateLogin(empE, E)).status, 200, 'E has no open role left');
  assert.equal((await block(ids.E, 'employer', false)).status, 200);
  assert.equal((await candidateLogin(empE, E)).status, 200);
  assert.equal((await empE.req('GET', '/api/employer/me')).status, 200);
  assert.equal((await cm.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId })).status, 201);
});

// ---- 2. every field of a job ---------------------------------------------------------------
let reqId = '';
await check('the edit form carries every field of the job; a staff-only added field is never shown back', async () => {
  const r = await empE.req('GET', `/api/employer/jobs/${jobId}`);
  assert.equal(r.status, 200, r.text);
  const v = r.json.data.values;
  for (const k of ['contactPersonName', 'contactPersonPhone', 'status', 'guestModeOverride', 'quickCvOverride', 'regularCvOverride', 'thresholdCondition']) {
    assert.ok(k in v, `${k} in the form`);
  }
  assert.equal(v.status, 'Active');
  assert.ok(!r.text.includes(`staff-secret-${stamp}`), 'the staff-only answer is not sent');
  assert.ok(!(HIDDEN_F in (v.customFields ?? {})));
});

await check('an edit request may change every field (contact, status, apply settings, added fields); the board stays as it is', async () => {
  const bad = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { isSponsored: true, pinnedAt: new Date().toISOString(), comments: 'x' });
  assert.equal(bad.json?.code, 'bad_field');
  const invalid = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { status: 'Deleted', guestModeOverride: 'open', contactPersonPhone: 'abc' });
  assert.equal(invalid.status, 400, invalid.text);
  assert.deepEqual(Object.keys(invalid.json.fields).sort(), ['contactPersonPhone', 'guestModeOverride', 'status']);
  const r = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, {
    contactPersonName: 'רונית מגייסת', contactPersonPhone: '050-7654321', status: 'Suspended', guestModeOverride: 'none', regularCvOverride: 'required',
    customFields: { [PUBLIC_F]: '12,000 ₪', [HIDDEN_F]: `from-employer-${stamp}` }, note: 'הכול',
  });
  assert.equal(r.status, 201, r.text);
  reqId = r.json.data.id;
  assert.deepEqual([...r.json.data.fields].sort(), ['contactPersonName', 'contactPersonPhone', `customFields.${HIDDEN_F}`, `customFields.${PUBLIC_F}`,
    'guestModeOverride', 'regularCvOverride', 'status'].sort());
  const pub = await anon.req('GET', `/api/jobs/${jobId}`);
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.data.status, 'Active', 'still active');
  const row = (await db.query(`SELECT status, guest_mode_override, regular_cv_override, contact_person_name, custom_fields FROM jobs WHERE id = $1`, [jobId])).rows[0];
  assert.equal(row.status, 'Active');
  assert.notEqual(row.guest_mode_override, 'none');
  assert.equal(row.regular_cv_override, null);
  assert.notEqual(row.contact_person_name, 'רונית מגייסת');
  assert.equal(row.custom_fields[HIDDEN_F], `staff-secret-${stamp}`, 'nothing applied yet');
  const mine = (await empE.req('GET', '/api/employer/edit-requests'));
  assert.ok(!mine.text.includes(`staff-secret-${stamp}`), 'the employer\'s list never carries the stored staff-only answer');
  const log = (await audit('jobs.edit_requested', `AND target = $2`, [reqId])).at(-1);
  assert.ok(!JSON.stringify(log.details).includes('רונית') && !JSON.stringify(log.details).includes('12,000'), 'field names only');
});

await check('a coordinator can\'t approve a change of apply settings (403 content_manager_required, nothing applied)', async () => {
  const r = await co.req('POST', `/api/admin/job-edit-requests/${reqId}/approve`, {});
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'content_manager_required');
  assert.deepEqual([...r.json.fields].sort(), ['guestModeOverride', 'regularCvOverride']);
  const s = await cm.req('GET', `/api/admin/job-edit-requests/${reqId}`);
  assert.equal(s.json.data.status, 'pending');
  const cmp = Object.fromEntries(s.json.data.comparison.map((c) => [c.field, c]));
  assert.equal(cmp.status.requested, 'Suspended');
  assert.equal(cmp.status.current, 'Active');
  assert.equal(cmp[`customFields.${HIDDEN_F}`].current, `staff-secret-${stamp}`, 'staff see the stored answer');
  assert.equal(cmp[`customFields.${HIDDEN_F}`].base, null, 'no base was kept for it');
});

await check('a content manager approves: every requested field reaches the job, logged by name', async () => {
  const r = await cm.req('POST', `/api/admin/job-edit-requests/${reqId}/approve`, {});
  assert.equal(r.status, 200, r.text);
  const row = (await db.query(`SELECT status, guest_mode_override, regular_cv_override, contact_person_name, contact_person_phone, custom_fields FROM jobs WHERE id = $1`, [jobId])).rows[0];
  assert.equal(row.status, 'Suspended');
  assert.equal(row.guest_mode_override, 'none');
  assert.equal(row.regular_cv_override, 'required');
  assert.equal(row.contact_person_name, 'רונית מגייסת');
  assert.equal(row.contact_person_phone, '050-7654321');
  assert.equal(row.custom_fields[PUBLIC_F], '12,000 ₪');
  assert.equal(row.custom_fields[HIDDEN_F], `from-employer-${stamp}`);
  const log = (await audit('jobs.edit_request_approved', `AND target = $2`, [reqId])).at(-1);
  assert.ok(log.details.fields.includes('guestModeOverride') && log.details.fields.includes('status'));
});

await check('a coordinator approves a change without apply settings; an empty staff-only answer leaves it; back to the site default', async () => {
  // The staff-only field sent empty = unchanged (the employer never saw it), never compared with the stored one.
  const same = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { customFields: { [HIDDEN_F]: '' } });
  assert.equal(same.json?.code, 'no_changes', same.text);
  const r = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { status: 'Active', contactPersonName: '', customFields: { [HIDDEN_F]: '' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([...r.json.data.fields].sort(), ['contactPersonName', 'status']);
  const a = await co.req('POST', `/api/admin/job-edit-requests/${r.json.data.id}/approve`, {});
  assert.equal(a.status, 200, a.text);
  const row = (await db.query(`SELECT status, contact_person_name, custom_fields FROM jobs WHERE id = $1`, [jobId])).rows[0];
  assert.equal(row.status, 'Active');
  assert.equal(row.contact_person_name || '', '');
  assert.equal(row.custom_fields[HIDDEN_F], `from-employer-${stamp}`, 'the staff-only answer unchanged');
  // Back to the site's default apply setting (null) — again a content manager's approval.
  const d = await empE.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { guestModeOverride: '' });
  assert.equal(d.status, 201, d.text);
  assert.equal((await co.req('POST', `/api/admin/job-edit-requests/${d.json.data.id}/approve`, {})).status, 403);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${d.json.data.id}/approve`, {})).status, 200);
  assert.equal((await db.query(`SELECT guest_mode_override FROM jobs WHERE id = $1`, [jobId])).rows[0].guest_mode_override, null);
});

await db.end();
for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? `  ${e}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
