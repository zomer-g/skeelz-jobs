// End-to-end checks for the three ways to apply and the CV rules (docs/jobs-management.md "Ways to apply")
// against a local server: guest mode none / self / quick, quick-apply CV required, regular-apply CV required with
// and without a profile CV, registered candidates always able to apply, the employer contact only on self-apply
// jobs (site, public API, MCP), site default vs per-job override, legacy isSelfApply, activity log.
//   BASE=http://localhost:3100 node test/e2e-apply-modes.mjs     (staff sign in through the mock xhostd SSO)
// Never point this at production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp as codeSignUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== 'true') {
  throw new Error('e2e writes data: run it against localhost only');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const PUB = '/api/public/v1';

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
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const pdfBytes = async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Test CV');
  return Buffer.from(await doc.save());
};
const upload = async (client, token, name = 'cv_test.pdf') => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdfBytes()], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
const mcpTool = async (name, args) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  return j.result?.isError ? null : JSON.parse(j.result.content[0].text);
};

const anon = jar();
const cm = jar();
const admin = jar();
const stamp = Date.now();
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'content manager sign-in (mock xhostd SSO)');
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'admin sign-in (mock xhostd SSO)');

const originalDefaults = (await cm.req('GET', '/api/admin/settings/apply-policy')).json.data;
const setDefaults = (v) => cm.req('PUT', '/api/admin/settings/apply-policy', v);
await setDefaults({ guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });

const skills = (await anon.req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;
const CONTACT = { contactPersonName: 'Employer Contact', contactPersonPhone: '03-5551234', contactPersonEmail: `jobs-${stamp}@employer.test` };
const createJob = async (title, extra = {}) => {
  const r = await cm.req('POST', '/api/jobs', {
    title, jobScope: ['FullTime'], companyName: 'E2E Apply Co', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, externalLink: 'https://employer.test/apply', ...CONTACT, ...extra,
  });
  assert.equal(r.status, 200, r.text);
  return r.json.data.id;
};
const tag = `E2EAPPLY${stamp}`;
const SELF = await createJob(`${tag} self`, { guestModeOverride: 'self' });
const QUICK = await createJob(`${tag} quick`, { guestModeOverride: 'quick', quickCvOverride: 'required' });
const NONE = await createJob(`${tag} none`, { guestModeOverride: 'none' });
const REG = await createJob(`${tag} regular`, { regularCvOverride: 'required' }); // guest mode: default (quick)
const INHERIT = await createJob(`${tag} inherit`);

const guestApply = (g, jobId, extra = {}) => g.req('POST', '/api/jobs/guestApply', {
  jobData: { _id: jobId },
  guestData: { fullName: 'Guest Modes', email: `modes-${crypto.randomUUID().slice(0, 8)}@example.test`, phoneNumber: '0504444444', ...extra },
  consent: true,
});

// Candidates: one with a CV on the profile, one without.
const signUp = async (client, email, cvFileUrl = '') => {
  const r = await codeSignUp(client, {
    firstName: 'Eee', lastName: 'Modes', email, phoneNumber: `05${String(crypto.randomInt(1e7, 1e8))}`,
    citySymbol: 9000, gender: 'other', dateOfBirth: '1990-01-01T00:00:00.000Z',
    skills: [], cvFileUrl, hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  return r;
};
const withCv = jar();
const noCv = jar();
const t0 = crypto.randomUUID();
assert.equal((await upload(withCv, t0, 'profile_cv.pdf')).status, 200);
await signUp(withCv, `modes-cv-${stamp}@example.test`, `${t0}/profile_cv.pdf`);
const noCvId = (await signUp(noCv, `modes-nocv-${stamp}@example.test`)).json.data._id;

await check('settings: content managers only; new shape validated; admin allowed too', async () => {
  assert.notEqual((await anon.req('GET', '/api/admin/settings/apply-policy')).status, 200);
  assert.equal((await admin.req('GET', '/api/admin/settings/apply-policy')).status, 200);
  assert.equal((await setDefaults({ guestMode: 'open' })).status, 400);
  assert.equal((await setDefaults({ quickCv: true })).status, 400);
  assert.equal((await setDefaults({ quickApply: false })).status, 400, 'the old fields are no longer accepted');
  const r = await cm.req('GET', '/api/admin/settings/apply-policy');
  assert.deepEqual(r.json.data, { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
});

await check('the public gets only the effective mode; the staff view also the overrides', async () => {
  const pub = (await anon.req('GET', `/api/jobs/${NONE}`)).json.data;
  assert.equal(pub.applyPolicy.guestMode, 'none');
  for (const k of ['guestModeOverride', 'quickCvOverride', 'regularCvOverride']) assert.ok(!(k in pub), `${k} leaked`);
  const staff = (await cm.req('GET', `/api/jobs/${NONE}`)).json.data;
  assert.equal(staff.guestModeOverride, 'none');
  assert.equal(staff.quickCvOverride, null);
  const api = (await anon.req('GET', `${PUB}/jobs/${NONE}`)).json.data;
  assert.equal(api.applyMode, 'none');
  assert.ok(!JSON.stringify(api).includes('Override'));
});

await check('guest mode none: guest apply refused (sign in); a registered candidate can apply', async () => {
  const r = await guestApply(jar(), NONE);
  assert.equal(r.status, 400);
  assert.equal(r.json?.code, 'jb10');
  const reg = await withCv.req('POST', `/api/jobs/apply/${NONE}`, { cv: { mode: 'profile' } });
  assert.equal(reg.status, 200, reg.text);
});

await check('guest mode self: the job page shows the employer contact; guest apply refused', async () => {
  const job = (await anon.req('GET', `/api/jobs/${SELF}`)).json.data;
  assert.equal(job.applyPolicy.guestMode, 'self');
  assert.equal(job.isSelfApply, true);
  assert.equal(job.contactPersonEmail, CONTACT.contactPersonEmail);
  assert.equal(job.contactPersonPhone, CONTACT.contactPersonPhone);
  assert.equal(job.externalLink, 'https://employer.test/apply');
  assert.ok(!('comments' in job), 'internal comments stay staff-only');
  const r = await guestApply(jar(), SELF);
  assert.equal(r.status, 400);
  assert.equal(r.json?.code, 'jb12');
});

await check('self apply: public API and MCP carry applyContact; other jobs carry none (site and API)', async () => {
  const api = (await anon.req('GET', `${PUB}/jobs/${SELF}`)).json.data;
  assert.equal(api.applyMode, 'self');
  assert.deepEqual(api.applyContact, { name: CONTACT.contactPersonName, email: CONTACT.contactPersonEmail, phone: CONTACT.contactPersonPhone });
  const viaMcp = await mcpTool('get_job', { id: SELF });
  assert.equal(viaMcp.applyMode, 'self');
  assert.equal(viaMcp.applyContact.email, CONTACT.contactPersonEmail);
  for (const id of [QUICK, NONE, INHERIT]) {
    const site = (await anon.req('GET', `/api/jobs/${id}`)).json.data;
    for (const k of ['contactPersonName', 'contactPersonPhone', 'contactPersonEmail']) assert.ok(!(k in site), `${k} on a non-self job`);
    assert.equal((await anon.req('GET', `${PUB}/jobs/${id}`)).json.data.applyContact, null);
  }
  const listed = (await anon.req('GET', `${PUB}/jobs?q=${encodeURIComponent(tag)}&limit=50`)).json.data;
  const bad = listed.filter((j) => j.applyContact && j.applyMode !== 'self');
  assert.deepEqual(bad, []);
  const board = (await anon.req('GET', `/api/jobs/active?filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs;
  assert.ok(board.length >= 4, `board shows the test jobs (${board.length})`);
  // The site's lists carry no contact details at all (not even self-apply jobs, and no uploadBy): the self-apply
  // view reads them from GET /api/jobs/:jobId.
  for (const j of board) {
    for (const k of ['contactPersonName', 'contactPersonPhone', 'contactPersonEmail', 'uploadBy']) assert.ok(!(k in j), `${k} on ${j.title} in /api/jobs/active`);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(!html.includes(CONTACT.contactPersonEmail), 'contact details in window.__INITIAL_DATA__');
});

await check('self apply: a signed-in candidate can still apply regularly', async () => {
  const r = await noCv.req('POST', `/api/jobs/apply/${SELF}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 200, r.text);
});

await check('quick apply, CV required: refused without one (or with an unclaimable path), accepted with an upload', async () => {
  const g = jar();
  const none = await guestApply(g, QUICK);
  assert.equal(none.status, 400);
  assert.equal(none.json?.code, 'jb11');
  const bogus = await guestApply(g, QUICK, { cvFilePath: `${crypto.randomUUID()}/not_uploaded.pdf` });
  assert.equal(bogus.json?.code, 'jb11');
  const t = crypto.randomUUID();
  assert.equal((await upload(g, t, 'guest_cv.pdf')).status, 200);
  const ok = await guestApply(g, QUICK, { cvFilePath: `${t}/guest_cv.pdf`, email: `stored-${stamp}@example.test` });
  assert.equal(ok.status, 200, ok.text);
});

await check('guest applications are stored (Salesforce off) and shown to content managers and admins, logged; CV through cvHandover', async () => {
  const find = async (who) => {
    const r = await who.req('GET', `/api/admin/guest-applications?jobId=${QUICK}&limit=50`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    return { list: r.json.data, row: r.json.data.applications.find((a) => a.email === `stored-${stamp}@example.test`) };
  };
  const { list, row } = await find(cm);
  assert.ok(row, 'the guest application was not stored');
  assert.equal(row.fullName, 'Guest Modes');
  assert.equal(row.hasCv, true);
  assert.equal(row.salesforceSentAt, null, 'Salesforce is off: not sent yet');
  assert.equal(list.salesforceEnabled, false);
  assert.ok(list.unsent >= 1);
  assert.ok(!JSON.stringify(list).includes('post-scan/'), 'the storage key leaked');
  assert.ok((await find(admin)).row, 'admins see them too');
  const cv = await cm.req('GET', `/api/admin/guest-applications/${row.id}/cv`);
  assert.equal(cv.status, 200);
  const audit = await admin.req('GET', `/api/admin/audit?subject=${row.id}`);
  const entries = audit.json.data.entries ?? audit.json.data;
  assert.ok(entries.some((e) => e.action === 'candidate.applications_viewed'), 'the list view is not logged with the guest id');
  assert.ok(entries.some((e) => e.action === 'candidate.cv_opened'), 'the CV open is not logged');
  const anonList = await anon.req('GET', '/api/admin/guest-applications');
  assert.notEqual(anonList.status, 200); assert.ok(!anonList.text.includes('Guest Modes'));
  const push = await cm.req('POST', '/api/admin/guest-applications/salesforce-push', {});
  assert.equal(push.status, 409); assert.equal(push.json.code, 'salesforce_disabled');
});

await check('quick apply, CV optional (default): accepted without a CV', async () => {
  const r = await guestApply(jar(), INHERIT);
  assert.equal(r.status, 200, r.text);
});

await check('regular apply, CV required, no profile CV: refused; with an upload: accepted', async () => {
  const refused = await noCv.req('POST', `/api/jobs/apply/${REG}`, { cv: { mode: 'profile' } });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json?.code, 'jb11');
  const bare = await noCv.req('POST', `/api/jobs/apply/${REG}`);
  assert.equal(bare.json?.code, 'jb11', 'an old client (no cv field) is refused too');
  const t = crypto.randomUUID();
  assert.equal((await upload(noCv, t, 'job_cv.pdf')).status, 200);
  const ok = await noCv.req('POST', `/api/jobs/apply/${REG}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/job_cv.pdf` } });
  assert.equal(ok.status, 200, ok.text);
});

await check('staff open a CV sent for one job only: not on the profile (fe17), through the application route + hand-over', async () => {
  // GET /files/:userId serves the PROFILE CV: this candidate has none ("no CV", not "user not found").
  const profile = await cm.req('GET', `/api/files/${noCvId}`);
  assert.equal(profile.status, 400, profile.text.slice(0, 200));
  assert.equal(profile.json?.code, 'fe17');
  const url = `/api/admin/users/${noCvId}/applications/${REG}/cv`;
  assert.notEqual((await anon.req('GET', url)).status, 200, 'anonymous got the CV');
  const r = await cm.req('GET', url);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment/);
  // An application sent without a CV: 404 fe22, nothing opened.
  const none = await cm.req('GET', `/api/admin/users/${noCvId}/applications/${INHERIT}/cv`);
  assert.equal(none.status, 404, none.text.slice(0, 200));
  assert.equal(none.json?.code, 'fe22');
  // Strict log: candidate.cv_opened with this candidate's id, via the application route.
  const audit = await admin.req('GET', `/api/admin/audit?subject=${noCvId}&action=candidate.cv_opened`);
  const entries = audit.json?.data?.entries ?? audit.json?.data ?? [];
  assert.ok(entries.some((e) => String(e.details?.via ?? '').includes('/applications/:jobId/cv')), `not logged: ${audit.text.slice(0, 300)}`);
  // The staff list says which applications carry a CV (job ids only), for the button in the applications list.
  const list = await cm.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(`modes-nocv-${stamp}`)}&usersFilter[page]=1&usersFilter[limit]=5`);
  const row = (list.json?.data?.users ?? []).find((u) => u._id === noCvId);
  assert.ok(row, `the candidate is not in the staff list: ${list.text.slice(0, 200)}`);
  assert.deepEqual(row.applicationCvJobs, [REG]);
});

await check('regular apply, CV required, with a profile CV: accepted with it', async () => {
  const r = await withCv.req('POST', `/api/jobs/apply/${REG}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.cvScope, 'profile');
});

await check('regular CV rule optional (default): a candidate without a CV can apply', async () => {
  const r = await noCv.req('POST', `/api/jobs/apply/${INHERIT}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 200, r.text);
});

await check('site default vs override: inheriting jobs follow the default (isSelfApply too), overrides do not', async () => {
  assert.equal((await setDefaults({ guestMode: 'self' })).status, 200);
  const inh = (await cm.req('GET', `/api/jobs/${INHERIT}`)).json.data;
  assert.equal(inh.applyPolicy.guestMode, 'self');
  assert.equal(inh.isSelfApply, true);
  assert.equal((await anon.req('GET', `/api/jobs/${NONE}`)).json.data.applyPolicy.guestMode, 'none');
  assert.equal((await guestApply(jar(), INHERIT)).json?.code, 'jb12');
  assert.equal((await setDefaults({ guestMode: 'quick' })).status, 200);
  assert.equal((await cm.req('GET', `/api/jobs/${INHERIT}`)).json.data.isSelfApply, false);
});

await check('inline edits (table) and legacy isSelfApply map onto the guest mode', async () => {
  const r = await cm.req('PATCH', `/api/admin/jobs/${INHERIT}/board`, { guestModeOverride: 'self', regularCvOverride: 'required' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.isSelfApply, true);
  assert.equal(r.json.data.applyPolicy.regularCv, 'required');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${INHERIT}/board`, { quickCvOverride: 'maybe' })).status, 400);
  // The old form field: false = back to the default (it was self).
  const legacy = await cm.req('PATCH', `/api/jobs/${INHERIT}`, { isSelfApply: false, status: 'Active' });
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.json.data.guestModeOverride ?? null, null);
  const back = (await cm.req('GET', `/api/jobs/${INHERIT}`)).json.data;
  assert.equal(back.guestModeOverride, null);
  assert.equal(back.applyPolicy.guestMode, 'quick');
  // isSelfApply: false never undoes 'none'.
  await cm.req('PATCH', `/api/jobs/${NONE}`, { isSelfApply: false, status: 'Active' });
  assert.equal((await cm.req('GET', `/api/jobs/${NONE}`)).json.data.guestModeOverride, 'none');
});

await check('activity log: settings and per-job changes with field names only', async () => {
  // The refused attempt above signed the admin out (a staff session hitting another role's route is ended).
  assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
  const s = await admin.req('GET', `/api/admin/audit?action=settings.apply_policy_updated`);
  assert.equal(s.status, 200, s.text);
  assert.ok((s.json.data.entries ?? s.json.data).some((e) => e.details?.guestMode), 'settings change logged');
  const j = await admin.req('GET', `/api/admin/audit?subject=${INHERIT}&action=job.board_updated`);
  const entries = j.json.data.entries ?? j.json.data;
  const e = entries.find((x) => (x.details?.fields ?? []).includes('guestModeOverride'));
  assert.ok(e, 'board change logged');
  assert.ok(!JSON.stringify(e.details).includes('self'), 'field names only, no values');
});

// Clean up: archive the test jobs, restore the defaults.
for (const id of [SELF, QUICK, NONE, REG, INHERIT]) await cm.req('POST', `/api/admin/jobs/${id}/archive`);
if (originalDefaults) await setDefaults(originalDefaults);

for (const [s, name, msg] of results) console.log(`${s}  ${name}${msg ? `\n      ${msg}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
