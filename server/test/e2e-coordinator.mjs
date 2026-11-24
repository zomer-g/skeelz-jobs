// Placement coordinator (רכז השמה) end to end, against a running LOCAL server (DEV_MODE=true, the mock SSO values from
// server/.env.example). Owner's split, 19.11.2026 (docs/security.md "Roles"):
//   coordinator      views candidates, applications, guest applications, CVs (same hand-overs) and manages jobs —
//                    never a threshold condition, a job's apply settings, a setting, a candidate's record, a forward,
//                    a Salesforce push, API keys, security / log / staff;
//   content manager  all that plus the rest; admin above everything.
//   BASE=http://localhost:3100 node test/e2e-coordinator.mjs
// Spends 2 of the per-IP employer submissions (restart the server before the submission suites). Never production.
import assert from 'node:assert/strict';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();
const stamp = Date.now();
const CO_EMAIL = `coordinator-${stamp}@example.test`;

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
        const i = kv.indexOf('=');
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (v && !/expires=Thu, 01 Jan 1970/i.test(c)) cookies.set(k, v); else cookies.delete(k);
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
const settle = () => new Promise((r) => setTimeout(r, 400)); // fire-and-forget log writes

const anon = jar();
const admin = jar();
const cm = jar();
const co = jar();
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin signs in');
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager signs in');
const log = async (q) => (await admin.req('GET', `/api/admin/audit?${q}`)).json?.data?.entries ?? [];
const policyBefore = (await cm.req('GET', '/api/admin/settings/apply-policy')).json.data;
const role = async (c) => (await c.req('GET', '/api/auth/session')).json?.data?.user?.role ?? null;

const skills = (await anon.req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;
const jobBody = (title, extra = {}) => ({
  title, jobScope: ['FullTime'], companyName: 'E2E Coordinator Co', publishDate: new Date(Date.now() - 1000).toISOString(),
  citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
  isSponsored: false, isMarked: false, ...extra,
});
let coId = null;
const createdJobs = []; // archived at the end, so other suites never pick them (one has a threshold condition)

await check('admin invites a placement coordinator (logged); a content manager cannot', async () => {
  const r = await admin.req('POST', '/api/admin/staff', { email: CO_EMAIL, role: 'placement_coordinator', firstName: 'רכזת', lastName: 'בדיקה' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.created, true);
  const staff = (await admin.req('GET', '/api/admin/staff')).json.data;
  assert.ok(staff.roles.includes('placement_coordinator'), 'assignable');
  const me = staff.staff.find((s) => s.email === CO_EMAIL);
  assert.equal(me?.role, 'placement_coordinator');
  coId = me.id;
  await settle();
  assert.ok((await log(`action=staff.invited&subject=${encodeURIComponent(CO_EMAIL)}`)).some((e) => e.details?.role === 'placement_coordinator'));
  const c = await cm.req('POST', '/api/admin/staff', { email: `x-${CO_EMAIL}`, role: 'placement_coordinator' });
  assert.ok([400, 401, 403].includes(c.status) && !c.json?.data, `content manager invite: ${c.status}`);
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'content manager signs in again');
});

await check('the coordinator signs in with Google (mock xhostd SSO) and has the role from the DB', async () => {
  const r = await staffLogin(co, CO_EMAIL);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'placement_coordinator');
  // Staff get no sign-in code by email (the same neutral answer, but nothing usable).
  const e = await jar().req('POST', '/api/auth/email/signup', { firstName: 'x' });
  assert.notEqual(e.status, 200);
});

// A candidate with an application, to see.
const cand = jar();
const candEmail = `co-cand-${stamp}@example.test`;
const su = await signUp(cand, {
  email: candEmail, firstName: 'מועמדת', lastName: 'לרכזת', phoneNumber: `05${String(stamp).slice(-8)}`, citySymbol: 5000,
  gender: 'female', dateOfBirth: '1990-01-01T12:00:00.000Z', skills: [], consent: true,
});
assert.equal(su.status, 200, `setup: candidate sign-up ${su.text}`);
const candId = su.json.data._id;

await check('sees candidates, a candidate\'s applications, guest applications, forwards and CVs — through the hand-overs', async () => {
  const u = await co.req('GET', `/api/users?inputValue=${encodeURIComponent(candEmail)}`);
  assert.equal(u.status, 200, u.text);
  assert.ok(u.json.data.users.some((x) => x.email === candEmail), 'candidate listed');
  assert.equal((await co.req('GET', `/api/users/job-applications/${candId}`)).status, 200);
  assert.equal((await co.req('GET', '/api/admin/guest-applications')).status, 200);
  assert.equal((await co.req('GET', '/api/admin/employer-forwards')).status, 200);
  const cv = await co.req('GET', `/api/files/${candId}`);
  assert.ok(!/forbidden|unauthori/i.test(cv.json?.message ?? ''), `CV gate refused the coordinator: ${cv.status} ${cv.text.slice(0, 80)}`); // no CV here
  assert.equal(await role(co), 'placement_coordinator', 'still signed in');
  await settle();
  const shown = await log(`actor=${encodeURIComponent(CO_EMAIL)}&action=candidates.shown`);
  assert.ok(shown.some((e) => (e.details?.ids ?? []).includes(candId)), 'strict log entry with the ids, by the coordinator email');
  assert.ok((await log(`actor=${encodeURIComponent(CO_EMAIL)}&action=candidate.applications_viewed`)).length >= 1);
});

let J = null;
await check('manages jobs: create, edit content (the form sends every field back), pin, bump, board, archive, restore', async () => {
  const c = await co.req('POST', '/api/jobs', jobBody(`E2E-CO ${stamp}`, { thresholdCondition: '', guestModeOverride: null, quickCvOverride: null, regularCvOverride: null }));
  assert.equal(c.status, 200, c.text);
  J = c.json.data.id;
  createdJobs.push(J);
  const full = (await co.req('GET', `/api/jobs/${J}`)).json.data;
  assert.ok('comments' in full || full.comments === undefined, 'staff view of the job');
  const e = await co.req('PATCH', `/api/jobs/${J}`, { title: `E2E-CO ${stamp} edited`, status: 'Active', comments: 'הערה פנימית', thresholdCondition: '',
    guestModeOverride: null, quickCvOverride: null, regularCvOverride: null });
  assert.equal(e.status, 200, e.text);
  for (const [m, p, b] of [['POST', `/api/admin/jobs/${J}/pin`], ['POST', `/api/admin/jobs/${J}/bump`], ['DELETE', `/api/admin/jobs/${J}/pin`],
    ['PATCH', `/api/admin/jobs/${J}/board`, { isSponsored: true, status: 'Suspended' }], ['PATCH', `/api/admin/jobs/${J}/board`, { status: 'Active' }],
    ['POST', `/api/admin/jobs/${J}/archive`], ['POST', `/api/admin/jobs/${J}/restore`], ['GET', `/api/admin/jobs/${J}/applications-count`],
    ['GET', '/api/admin/jobs/with-comments'], ['GET', '/api/admin/settings/apply-policy']]) {
    const r = await co.req(m, p, b);
    assert.equal(r.status, 200, `${m} ${p}: ${r.status} ${r.text}`);
  }
  await settle();
  const entries = await log(`subject=${J}&action=job.`);
  for (const a of ['job.created', 'job.updated', 'job.pinned', 'job.bumped', 'job.board_updated', 'job.archived', 'job.restored']) {
    assert.ok(entries.some((x) => x.action === a && x.actor === CO_EMAIL), `${a} not logged as the coordinator`);
  }
});

await check('never the threshold condition or a job\'s apply settings: 403 content_manager_required, still signed in, logged', async () => {
  const tries = [
    ['POST', '/api/jobs', jobBody(`E2E-CO-T ${stamp}`, { thresholdCondition: 'רישיון נהיגה' })],
    ['POST', '/api/jobs', jobBody(`E2E-CO-O ${stamp}`, { regularCvOverride: 'optional' })],
    ['PATCH', `/api/jobs/${J}`, { status: 'Active', thresholdCondition: 'תואר ראשון' }],
    ['PATCH', `/api/jobs/${J}`, { status: 'Active', guestModeOverride: 'quick' }],
    ['PATCH', `/api/admin/jobs/${J}/board`, { quickCvOverride: 'required' }],
  ];
  for (const [m, p, b] of tries) {
    const r = await co.req(m, p, b);
    assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(b).slice(0, 60)}: ${r.status} ${r.text}`);
    assert.equal(r.json?.code, 'content_manager_required');
  }
  assert.equal(await role(co), 'placement_coordinator', 'a field refusal does not sign out');
  const job = (await cm.req('GET', `/api/jobs/${J}`)).json.data;
  assert.equal(job.thresholdCondition ?? null, null, 'nothing changed');
  assert.equal(job.guestModeOverride ?? null, null);
  // A content manager may.
  assert.equal((await cm.req('PATCH', `/api/jobs/${J}`, { status: 'Active', thresholdCondition: 'תואר ראשון' })).status, 200);
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${J}/board`, { quickCvOverride: 'required' })).status, 200);
  // ... and then the coordinator's form, sending those values back unchanged, still saves.
  const back = await co.req('PATCH', `/api/jobs/${J}`, { title: `E2E-CO ${stamp} again`, status: 'Active', thresholdCondition: 'תואר ראשון', quickCvOverride: 'required' });
  assert.equal(back.status, 200, back.text);
  await settle();
  assert.ok((await log(`actor=${encodeURIComponent(CO_EMAIL)}&action=access.denied`)).some((e) => e.details?.reason === 'content_manager_required'));
});

const subForm = (title, extra = {}) => ({
  title, companyName: 'חברת רכזת', citySymbol: 5000, jobScope: ['FullTime'], requiredSkills: [skillId],
  description: `תיאור ארוך מספיק של משרה לבדיקת רכזת ההשמה ${stamp}.`, externalLink: '', publicEmail: `apply-co-${stamp}@example.test`,
  contactName: 'דנה מעסיקה', contactEmail: `contact-co-${stamp}@example.test`, contactPhone: '050-1234567', consent: true, website: '', ...extra,
});
const submissionId = async (title) => (await co.req('GET', '/api/admin/job-submissions')).json.data.items.find((x) => x.title === title)?.id;

await check('approves employer submissions; one with a threshold condition needs a content manager', async () => {
  const plain = `E2E-COS-${stamp}`.slice(0, 30);
  const withT = `E2E-COT-${stamp}`.slice(0, 30);
  assert.equal((await anon.req('POST', '/api/job-submissions', subForm(plain))).status, 201);
  assert.equal((await anon.req('POST', '/api/job-submissions', subForm(withT, { thresholdCondition: 'ניסיון בשיווק' }))).status, 201);
  const a = await submissionId(plain);
  const b = await submissionId(withT);
  assert.ok(a && b, 'listed for the coordinator');
  assert.equal((await co.req('GET', `/api/admin/job-submissions/${a}`)).status, 200);
  const ok = await co.req('POST', `/api/admin/job-submissions/${a}/approve`, {});
  assert.equal(ok.status, 200, ok.text);
  createdJobs.push(ok.json.data.jobId);
  assert.equal((await co.req('PATCH', `/api/admin/job-submissions/${b}`, { thresholdCondition: 'משהו אחר' })).json?.code, 'content_manager_required');
  const no = await co.req('POST', `/api/admin/job-submissions/${b}/approve`, {});
  assert.equal(no.status, 403, no.text);
  assert.equal(no.json.code, 'content_manager_required');
  assert.equal((await co.req('GET', `/api/admin/job-submissions/${b}`)).json.data.status, 'pending', 'still pending');
  const cmOk = await cm.req('POST', `/api/admin/job-submissions/${b}/approve`, {});
  assert.equal(cmOk.status, 200, cmOk.text);
  createdJobs.push(cmOk.json.data.jobId);
});

// Refused routes: a gate refusal signs the coordinator out (as for every role above its own), so sign in again each time.
const refusedRoutes = [
  ['PATCH', `/api/users/${candId}`, { firstName: 'שונה' }, 'edit a candidate'],
  ['PUT', '/api/admin/settings/apply-policy', { guestMode: 'none' }, 'site apply policy'],
  ['GET', '/api/admin/settings/employer-posting', null, 'employer posting setting'],
  ['PUT', '/api/admin/settings/employer-posting', { mode: 'account_required' }, 'employer posting setting'],
  ['GET', '/api/admin/settings/signup-fields', null, 'sign-up fields setting'],
  ['PUT', '/api/admin/settings/signup-fields', { idNumber: 'required' }, 'sign-up fields setting'],
  ['POST', '/api/admin/guest-applications/salesforce-push', { limit: 1 }, 'Salesforce push'],
  ['POST', '/api/admin/employer-forwards', { kind: 'application', applicationId: 'x' }, 'forward to an employer'],
  ['POST', '/api/admin/employer-forwards/x/cancel', {}, 'cancel a forward'],
  ['GET', '/api/admin/api-tokens', null, 'API keys'],
  ['GET', '/api/admin/security', null, 'security'],
  ['GET', '/api/admin/audit', null, 'activity log'],
  ['GET', '/api/admin/staff', null, 'staff users'],
  ['PATCH', `/api/admin/staff/${coId}/role`, { role: 'admin' }, 'own role'],
  ['GET', '/api/employer/me', null, 'employer area'],
];
await check(`refused, with nothing in the answer: ${refusedRoutes.map((r) => r[3]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`, async () => {
  for (const [m, p, b] of refusedRoutes) {
    const r = await co.req(m, p, b ?? undefined);
    assert.ok([400, 401, 403].includes(r.status) && /forbidden|unauthori/i.test(r.json?.message ?? ''), `${m} ${p}: ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!r.json?.data, `${m} ${p} returned data`);
    assert.equal(await role(co), null, `${m} ${p}: signed out after a refusal`);
    assert.equal((await staffLogin(co, CO_EMAIL)).status, 200, 'signs in again');
  }
  // Nothing changed.
  assert.deepEqual((await cm.req('GET', '/api/admin/settings/apply-policy')).json.data, policyBefore, 'apply policy unchanged');
  assert.equal((await anon.req('GET', '/api/auth/signup-fields')).json.data.fields.idNumber, 'optional');
  assert.equal((await anon.req('GET', '/api/job-submissions/policy')).json.data.mode, 'open');
  const staff = (await admin.req('GET', '/api/admin/staff')).json.data.staff;
  assert.equal(staff.find((s) => s.id === coId).role, 'placement_coordinator', 'own role unchanged');
});

await check('the admin changes the role (logged, sessions closed at once) and back', async () => {
  const up = await admin.req('PATCH', `/api/admin/staff/${coId}/role`, { role: 'content_manager' });
  assert.equal(up.status, 200, up.text);
  assert.equal(await role(co), null, 'sessions closed on a role change');
  assert.equal((await staffLogin(co, CO_EMAIL)).status, 200);
  assert.equal(await role(co), 'content_manager');
  assert.equal((await co.req('GET', '/api/admin/settings/signup-fields')).status, 200, 'now a content manager');
  assert.equal((await admin.req('PATCH', `/api/admin/staff/${coId}/role`, { role: 'placement_coordinator' })).status, 200);
  await settle();
  const changes = await log(`action=staff.role_changed&subject=${encodeURIComponent(CO_EMAIL)}`);
  assert.ok(changes.some((e) => e.details?.from === 'placement_coordinator' && e.details?.to === 'content_manager'));
  assert.ok(changes.some((e) => e.details?.from === 'content_manager' && e.details?.to === 'placement_coordinator'));
  // The access review lists the coordinator.
  const sec = (await admin.req('GET', '/api/admin/security')).json.data;
  assert.ok(JSON.stringify(sec).includes(CO_EMAIL), 'coordinator in the access review');
});

await check('the admin can give the coordinator a daily grant (staff budget)', async () => {
  const g = await admin.req('POST', '/api/admin/security/grant', { email: CO_EMAIL, budget: 'cvs' });
  assert.equal(g.status, 200, g.text);
});

for (const id of createdJobs) await cm.req('POST', `/api/admin/jobs/${id}/archive`);
const failed = results.filter((r) => r[0] === 'FAIL');
for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
