// End-to-end checks of employer accounts (docs/employers.md) against a running LOCAL server (fresh dev DB,
// integrations off, EMAIL_CODE_SIGNIN_ENABLED=true, the mock SSO values from server/.env.example):
//   BASE=http://localhost:3100 [DATABASE_URL=postgresql://…] node test/e2e-employers.mjs
// - the setting: open (anonymous form) vs account_required (only a signed-in employer), set by a content manager;
// - employer sign-up by the dev email code; an existing candidate's address never becomes an employer;
// - own submissions / own jobs only; another employer sees nothing of them;
// - edit request → pending (the public board unchanged) → reject (reason shown) / approve (applied) / withdraw;
// - claiming earlier anonymous submissions by the verified sign-in email;
// - employers refused on every staff and candidate route; staff and candidates refused on /employer/*;
// - a job imported from the existing site can't get an edit request (with DATABASE_URL: shown read-only too).
// Uses 4 of the 5 employer-form submissions an IP may send per hour: restart the server before re-running.
import assert from 'node:assert/strict';
import { ensureImportedJob, isSkip, skip, summary } from './helpers/localDb.mjs';
import crypto from 'node:crypto';
import { staffLogin, xhostdSignIn, signedInOk } from './helpers/staffLogin.mjs';
import { devCode, signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    clear: () => cookies.clear(),
    async req(method, path, body) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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
// A refused session: 401 / 403, or the gate's own answer (400 with code Forbidden — errorMiddleware maps the gate's error).
const refused = (r) => r.status === 401 || r.status === 403 || (r.status === 400 && /^(Forbidden|Unauthorized|au\d+)$/.test(String(r.json?.code ?? '')));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push([isSkip(e) ? 'SKIP' : 'FAIL', name, e.message]); }
};

const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;
const anon = jar();
const cm = jar();
const sec = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const EMP1 = `emp1-${stamp}@example.test`;
const EMP2 = `emp2-${stamp}@example.test`;
const CAND = `cand-${stamp}@example.test`;
const form = (title, contactEmail = `contact-${stamp}@example.test`) => ({
  title, companyName: 'חברת מעסיק', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
  description: `תיאור ארוך מספיק של משרה לבדיקת חשבונות מעסיקים ${stamp}.`,
  externalLink: '', publicEmail: `apply-${stamp}@example.test`,
  contactName: 'דנה מעסיקה', contactEmail, contactPhone: '050-1234567', consent: true, website: '',
});
const T_ANON = `E2E-EA-${stamp}`.slice(0, 30);
const T_EMP = `E2E-EE-${stamp}`.slice(0, 30);
const T_NEW = `E2E-EN-${stamp}`.slice(0, 30);
const boardTitles = async () => (await anon.req('GET', '/api/jobs/active?limit=100')).json.data.jobs.map((j) => j.title);

/** Signs a new address up as an EMPLOYER through the real email-code routes. Returns the sign-up answer. */
const employerSignUp = async (client, email, details = {}) => {
  const code = await devCode(client, email);
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  if (v.json?.data?.status !== 'signup') return v;
  return client.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה בע"מ', phone: phone(),
    jobTitle: 'מגייסת', consent: true, marketingConsent: false, ...details,
  });
};
/** Signs an existing account in again (the refused-route checks sign the session out). */
const relogin = async (client, email) => {
  client.clear();
  const r = await candidateLogin(client, email);
  assert.equal(r.status, 200, `re-login ${email}: ${r.text}`);
};

// ---------------------------------------------------------------------------
await check('staff sign in; the setting is "open" by default (public policy, staff view)', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(sec, ADMIN_EMAIL)).status, 200);
  assert.equal((await anon.req('GET', '/api/job-submissions/policy')).json.data.mode, 'open');
  assert.equal((await cm.req('GET', '/api/admin/settings/employer-posting')).json.data.mode, 'open');
});

await check('open: an anonymous submission is accepted as before (its contact email = a future employer)', async () => {
  const r = await anon.req('POST', '/api/job-submissions', form(T_ANON, EMP2));
  assert.equal(r.status, 201, r.text);
});

const cand = jar();
await check('a candidate account exists (for the role checks)', async () => {
  const r = await signUp(cand, {
    firstName: 'מועמד', lastName: 'בדיקה', email: CAND, phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'user');
});

await check('the setting: bad values refused; a content manager sets account_required (logged); a candidate cannot', async () => {
  assert.equal((await cm.req('PUT', '/api/admin/settings/employer-posting', { mode: 'closed' })).status, 400);
  assert.equal((await cm.req('PUT', '/api/admin/settings/employer-posting', { mode: 'open', extra: 1 })).status, 400);
  const r = await cm.req('PUT', '/api/admin/settings/employer-posting', { mode: 'account_required' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.mode, 'account_required');
  assert.equal((await anon.req('GET', '/api/job-submissions/policy')).json.data.mode, 'account_required');
  const log = (await sec.req('GET', '/api/admin/audit?action=settings.employer_posting_updated')).json.data.entries;
  assert.ok(log.some((e) => e.details?.mode === 'account_required' && e.actor === CM_EMAIL), 'logged with the content manager');
  assert.ok(refused(await cand.req('PUT', '/api/admin/settings/employer-posting', { mode: 'open' })));
  await relogin(cand, CAND);
});

await check('account_required: anonymous → 401 employer_sign_in_required; a candidate → 403 employer_account_required', async () => {
  const a = await anon.req('POST', '/api/job-submissions', form(`E2E-X-${stamp}`.slice(0, 30)));
  assert.equal(a.status, 401, a.text);
  assert.equal(a.json.code, 'employer_sign_in_required');
  const c = await cand.req('POST', '/api/job-submissions', form(`E2E-Y-${stamp}`.slice(0, 30)));
  assert.equal(c.status, 403, c.text);
  assert.equal(c.json.code, 'employer_account_required');
});

const emp = jar();
let empId = '';
await check('employer sign-up by email code: details checked, consent required, role employer, email from the cookie', async () => {
  const code = await devCode(emp, EMP1);
  const v = await emp.req('POST', '/api/auth/email/verify', { email: EMP1, code });
  assert.equal(v.json?.data?.status, 'signup', v.text);
  const bad = await emp.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'D1', lastName: '', companyName: 'x', phone: '123', consent: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'employer_invalid');
  assert.deepEqual([...bad.json.fields].sort(), ['companyName', 'firstName', 'lastName', 'phone']);
  const noConsent = await emp.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone() });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.json.code, 'terms_required');
  const r = await emp.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה בע"מ', phone: '050-765-4321',
    consent: true, email: 'someone-else@example.test', role: 'admin',
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'employer');
  assert.equal(r.json.data.user.email, EMP1, 'the email comes from the verified cookie, not the form');
  assert.equal(r.json.data.user.employer.companyName, 'אקמה בע"מ');
  empId = r.json.data.user._id ?? r.json.data.user.id;
  const s = (await emp.req('GET', '/api/auth/session')).json.data;
  assert.equal(s.user.role, 'employer');
  assert.equal(s.profileIncomplete, false);
  const me = (await emp.req('GET', '/api/employer/me')).json.data;
  assert.equal(me.phone, '0507654321');
  const log = (await sec.req('GET', `/api/admin/audit?action=auth.signup_employer&subject=${empId}`)).json.data.entries;
  assert.ok(log.length >= 1 && !JSON.stringify(log).includes(EMP1), 'logged, without the address');
});

await check('employer sign-up after "Continue with Google": the same form, linked to the identity; signing in again finds it', async () => {
  const g = jar();
  const email = `emp-g-${stamp}@example.test`;
  const cb = await xhostdSignIn(g, email, { claims: { name: 'גיל גוגל' } });
  assert.match(cb.headers.get('location') || '', /signin=signup/);
  const pending = (await g.req('GET', '/api/auth/xhostd/signup')).json.data;
  assert.equal(pending.email, email);
  const r = await g.req('POST', '/api/auth/xhostd/signup', {
    accountType: 'employer', firstName: 'גיל', lastName: 'גוגל', companyName: 'גוגלית', phone: phone(), consent: true,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'employer');
  const again = jar();
  assert.ok(signedInOk(await xhostdSignIn(again, email)), 'signs in to the same account');
  assert.equal((await again.req('GET', '/api/auth/session')).json.data.user.role, 'employer');
  assert.equal((await again.req('GET', '/api/employer/me')).json.data.companyName, 'גוגלית');
});

await check("an existing candidate's address never becomes an employer (it signs in to the candidate account)", async () => {
  const c = jar();
  const code = await devCode(c, CAND);
  const v = await c.req('POST', '/api/auth/email/verify', { email: CAND, code });
  assert.equal(v.json.data.status, 'signed_in');
  assert.equal(v.json.data.user.role, 'user');
  // Without a pending sign-up cookie the employer form can't create anything.
  const r = await c.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone(), consent: true });
  assert.equal(r.status, 401, r.text);
  assert.equal((await c.req('GET', '/api/auth/session')).json.data.user.role, 'user');
});

await check('staff can never get an employer account (no code for staff, the dev route refuses too)', async () => {
  const s = jar();
  assert.equal((await s.req('POST', '/api/dev/email-code', { email: CM_EMAIL })).status, 403);
});

let jobId = '';
await check('account_required: the employer sends a job → pending in their area, linked, not public', async () => {
  const r = await emp.req('POST', '/api/job-submissions', form(T_EMP, 'other-contact@example.test'));
  assert.equal(r.status, 201, r.text);
  const subs = (await emp.req('GET', '/api/employer/submissions')).json.data.items;
  const mine = subs.find((x) => x.title === T_EMP);
  assert.ok(mine, 'listed in the employer area');
  assert.equal(mine.status, 'pending');
  assert.ok(!('contactEmail' in mine) && !('contactPhone' in mine), 'no contact details in the list');
  assert.ok(!(await boardTitles()).includes(T_EMP));
  const list = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items;
  assert.equal(list.find((x) => x.title === T_EMP)?.byAccount, true, 'staff see it came from an account');
  const s = list.find((x) => x.title === T_EMP);
  const ap = await cm.req('POST', `/api/admin/job-submissions/${s.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  jobId = ap.json.data.jobId;
});

await check('after approval: public, listed in "my jobs" with status and publish date, submission approved', async () => {
  assert.ok((await boardTitles()).includes(T_EMP));
  const jobs = (await emp.req('GET', '/api/employer/jobs')).json.data.items;
  const j = jobs.find((x) => x.id === jobId);
  assert.ok(j, 'own job listed');
  assert.equal(j.status, 'Active');
  assert.ok(j.publishDate);
  assert.equal(j.readOnly, false);
  assert.equal((await emp.req('GET', '/api/employer/submissions')).json.data.items.find((x) => x.title === T_EMP).status, 'approved');
  const one = (await emp.req('GET', `/api/employer/jobs/${jobId}`)).json.data;
  assert.equal(one.values.title, T_EMP);
  assert.equal(one.values.publicEmail, `apply-${stamp}@example.test`);
  assert.ok(!/<[a-z]/i.test(one.values.description), 'the description is plain text for the form');
  assert.ok(!('comments' in one) && !('comments' in one.values), 'no internal comments');
});

const emp2 = jar();
await check('another employer sees none of it; claims only their own earlier anonymous submission', async () => {
  const r = await employerSignUp(emp2, EMP2);
  assert.equal(r.status, 200, r.text);
  assert.equal((await emp2.req('GET', '/api/employer/jobs')).json.data.items.length, 0);
  assert.equal((await emp2.req('GET', `/api/employer/jobs/${jobId}`)).status, 404);
  assert.equal((await emp2.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { title: 'חטיפה' })).status, 404);
  assert.ok(!(await emp2.req('GET', '/api/employer/submissions')).json.data.items.some((x) => x.title === T_EMP));
  // EMP2's address was the contact email of the anonymous submission sent first.
  assert.equal((await emp2.req('GET', '/api/employer/me')).json.data.claimable, 1);
  assert.equal((await emp.req('GET', '/api/employer/me')).json.data.claimable, 0, 'not claimable by another address');
  const c = await emp2.req('POST', '/api/employer/submissions/claim', {});
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.data.claimed, 1);
  const subs = (await emp2.req('GET', '/api/employer/submissions')).json.data.items;
  assert.ok(subs.some((x) => x.title === T_ANON && x.claimed), 'claimed into the account');
  assert.equal((await emp2.req('GET', '/api/employer/me')).json.data.claimable, 0);
  assert.equal((await emp2.req('POST', '/api/employer/submissions/claim', {})).json.data.claimed, 0, 'nothing twice');
});

let reqId = '';
await check('edit request: only allowed fields, validated, real changes only; stored pending, the board unchanged', async () => {
  const p = `/api/employer/jobs/${jobId}/edit-requests`;
  const bf = await emp.req('POST', p, { pinnedAt: new Date().toISOString() }); // board fields stay with SKEELZ (24.11.2026)
  assert.equal(bf.status, 400); assert.equal(bf.json.code, 'bad_field');
  const bf2 = await emp.req('POST', p, { isSponsored: true, title: T_NEW });
  assert.equal(bf2.status, 400); assert.equal(bf2.json.code, 'bad_field');
  const nc = await emp.req('POST', p, { title: T_EMP });
  assert.equal(nc.status, 400); assert.equal(nc.json.code, 'no_changes');
  const inv = await emp.req('POST', p, { title: 'x', publicEmail: 'nope' });
  assert.equal(inv.status, 400); assert.equal(inv.json.fields.title, 'too_short'); assert.equal(inv.json.fields.publicEmail, 'invalid');
  const ok = await emp.req('POST', p, { title: T_NEW, description: `תיאור חדש ומעודכן למשרה ${stamp}, עם <b>תגית</b>.`, note: 'עדכון כותרת' });
  assert.equal(ok.status, 201, ok.text);
  reqId = ok.json.data.id;
  assert.deepEqual([...ok.json.data.fields].sort(), ['description', 'title']);
  const again = await emp.req('POST', p, { title: `${T_NEW}2`.slice(0, 30) });
  assert.equal(again.status, 409); assert.equal(again.json.code, 'edit_pending');
  const titles = await boardTitles();
  assert.ok(titles.includes(T_EMP) && !titles.includes(T_NEW), 'the live job is unchanged');
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.title, T_EMP);
  const mine = (await emp.req('GET', '/api/employer/jobs')).json.data.items.find((x) => x.id === jobId);
  assert.equal(mine.pendingRequestId, reqId);
});

await check('staff queue: listed, per-field comparison; reject keeps the job and shows the reason to the employer', async () => {
  const list = (await cm.req('GET', '/api/admin/job-edit-requests')).json.data;
  const item = list.items.find((x) => x.id === reqId);
  assert.ok(item, 'in the pending queue');
  assert.equal(item.employer.companyName, 'אקמה בע"מ');
  const d = (await cm.req('GET', `/api/admin/job-edit-requests/${reqId}`)).json.data;
  const t = d.comparison.find((c) => c.field === 'title');
  assert.equal(t.base, T_EMP); assert.equal(t.current, T_EMP); assert.equal(t.requested, T_NEW); assert.equal(t.changedSince, false);
  const rj = await cm.req('POST', `/api/admin/job-edit-requests/${reqId}/reject`, { reason: 'הכותרת לא ברורה' });
  assert.equal(rj.status, 200, rj.text);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${reqId}/approve`, {})).status, 409, 'no longer pending');
  assert.equal((await anon.req('GET', `/api/jobs/${jobId}`)).json.data.title, T_EMP);
  const mine = (await emp.req('GET', '/api/employer/edit-requests')).json.data.items.find((x) => x.id === reqId);
  assert.equal(mine.status, 'rejected');
  assert.equal(mine.rejectReason, 'הכותרת לא ברורה');
  const log = (await sec.req('GET', `/api/admin/audit?subject=${reqId}`)).json.data.entries;
  assert.ok(log.some((e) => e.action === 'jobs.edit_request_rejected' && e.details?.has_reason === true));
  assert.ok(!JSON.stringify(log).includes('הכותרת לא ברורה'), 'the reason text is not in the log');
});

await check('withdraw: the employer withdraws their own pending request; another employer cannot', async () => {
  const r = await emp.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { companyName: 'אקמה החדשה' });
  assert.equal(r.status, 201, r.text);
  const id = r.json.data.id;
  assert.equal((await emp2.req('POST', `/api/employer/edit-requests/${id}/withdraw`, {})).status, 409);
  assert.equal((await emp.req('POST', `/api/employer/edit-requests/${id}/withdraw`, {})).status, 200);
  assert.equal((await emp.req('GET', '/api/employer/edit-requests')).json.data.items.find((x) => x.id === id).status, 'withdrawn');
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${id}/approve`, {})).status, 409);
});

await check('approve: applied to the public job (plain text made safe), logged as job.updated via employer_request', async () => {
  const r = await emp.req('POST', `/api/employer/jobs/${jobId}/edit-requests`, { title: T_NEW, description: `תיאור חדש ומעודכן למשרה ${stamp}, עם <b>תגית</b>.` });
  assert.equal(r.status, 201, r.text);
  const id = r.json.data.id;
  const ap = await cm.req('POST', `/api/admin/job-edit-requests/${id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  const pub = (await anon.req('GET', `/api/jobs/${jobId}`)).json.data;
  assert.equal(pub.title, T_NEW);
  assert.ok(!pub.description.includes('<b>') && pub.description.includes('&lt;b&gt;'), 'escaped, not markup');
  assert.ok((await boardTitles()).includes(T_NEW));
  assert.equal((await emp.req('GET', '/api/employer/edit-requests')).json.data.items.find((x) => x.id === id).status, 'approved');
  const log = (await sec.req('GET', `/api/admin/audit?subject=${jobId}&action=job.updated`)).json.data.entries;
  assert.ok(log.some((e) => e.details?.via === 'employer_request' && e.actor === CM_EMAIL));
  const reqLog = (await sec.req('GET', `/api/admin/audit?subject=${id}`)).json.data.entries;
  assert.ok(reqLog.some((e) => e.action === 'jobs.edit_requested' && e.actor === `user:${empId}`));
  assert.ok(!JSON.stringify(reqLog).includes(T_NEW), 'field names only, never the values');
});

await check('the employer edits their own details (allowlist); never email or role', async () => {
  assert.equal((await emp.req('PATCH', '/api/employer/me', { email: 'x@example.test' })).status, 400);
  assert.equal((await emp.req('PATCH', '/api/employer/me', { role: 'admin' })).status, 400);
  assert.equal((await emp.req('PATCH', '/api/employer/me', { phone: '12' })).status, 400);
  const r = await emp.req('PATCH', '/api/employer/me', { companyName: 'אקמה החדשה בע"מ', jobTitle: '' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.companyName, 'אקמה החדשה בע"מ');
  assert.equal(r.json.data.jobTitle, null);
  assert.equal(r.json.data.email, EMP1);
});

await check('a job imported from the existing site: not theirs → 404 (says nothing); theirs → read-only, 409 job_read_only', async () => {
  await ensureImportedJob(); // with DATABASE_URL: seeds one on a fresh DB (helpers/localDb.mjs)
  const all = (await cm.req('GET', '/api/admin/jobs/with-comments')).json.data;
  const imported = (Array.isArray(all) ? all : all.jobs ?? []).find((j) => j.importedFromLive);
  if (!imported) throw skip('no imported job on this DB: run with DATABASE_URL (seeds one) or after test/local-setup.mjs');
  const r = await emp.req('POST', `/api/employer/jobs/${imported._id}/edit-requests`, { title: 'שינוי' });
  assert.equal(r.status, 404, r.text);
  assert.equal(r.json.code, 'job_not_found');
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query(`INSERT INTO employer_jobs (job_id, user_id, via) VALUES ($1, $2, 'test') ON CONFLICT DO NOTHING`, [imported._id, empId]);
    } finally { await db.end(); }
    const j = (await emp.req('GET', '/api/employer/jobs')).json.data.items.find((x) => x.id === imported._id);
    assert.equal(j?.readOnly, true, 'listed read-only');
    assert.equal((await emp.req('GET', `/api/employer/jobs/${imported._id}`)).json.data.readOnly, true);
    assert.equal((await emp.req('POST', `/api/employer/jobs/${imported._id}/edit-requests`, { title: 'שינוי' })).json.code, 'job_read_only');
  }
});

await check('staff and candidates are refused on every /employer route', async () => {
  for (const [who, c, email, login] of [['candidate', cand, CAND, relogin], ['content manager', cm, CM_EMAIL, null]]) {
    for (const [m, p] of [['GET', '/api/employer/me'], ['GET', '/api/employer/jobs'], ['GET', '/api/employer/submissions'],
      ['POST', `/api/employer/jobs/${jobId}/edit-requests`], ['POST', '/api/employer/submissions/claim']]) {
      if (login) await login(c, email); else { c.clear(); assert.equal((await staffLogin(c, email)).status, 200); }
      const r = await c.req(m, p, m === 'POST' ? { title: 'x' } : undefined);
      assert.ok(refused(r), `${who} ${m} ${p}: ${r.status}`);
    }
  }
  assert.ok(refused(await anon.req('GET', '/api/employer/me')));
});

await check('an employer is refused on every staff and candidate route (never candidates, applications or CVs)', async () => {
  const routes = [
    ['GET', '/api/users'], ['GET', '/api/users/me'], ['PATCH', '/api/users/me'], ['GET', '/api/users/me/cv'],
    ['GET', `/api/users/job-applications/${empId}`], ['GET', `/api/files/${empId}`], ['POST', `/api/jobs/apply/${jobId}`],
    ['GET', '/api/admin/guest-applications'], ['GET', '/api/admin/job-submissions'], ['GET', '/api/admin/job-edit-requests'],
    ['POST', `/api/admin/job-edit-requests/${reqId}/approve`], ['GET', '/api/admin/settings/employer-posting'],
    ['PUT', '/api/admin/settings/employer-posting'], ['GET', '/api/admin/jobs/with-comments'], ['PATCH', `/api/jobs/${jobId}`],
    ['GET', '/api/admin/security'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/staff'], ['GET', '/api/admin/api-tokens'],
  ];
  for (const [m, p] of routes) {
    await relogin(emp, EMP1);
    const r = await emp.req(m, p, ['POST', 'PUT', 'PATCH'].includes(m) ? { mode: 'open', title: 'x' } : undefined);
    assert.ok(refused(r), `${m} ${p}: ${r.status} ${r.text.slice(0, 80)}`);
  }
  assert.equal((await cm.req('GET', '/api/job-submissions/policy')).json.data.mode, 'account_required', 'the setting was not changed');
});

await check('back to open: the public policy says so again', async () => {
  cm.clear();
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200); // the refused-route checks signed it out
  const r = await cm.req('PUT', '/api/admin/settings/employer-posting', { mode: 'open' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await anon.req('GET', '/api/job-submissions/policy')).json.data.mode, 'open');
});

for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${summary(results)}`);
process.exit(failed ? 1 : 0);
