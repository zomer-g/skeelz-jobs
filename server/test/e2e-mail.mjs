// The mail screen and the service-email events (src/mail, docs/mail.md), end to end against a running LOCAL server.
// Nothing is sent: run the server with email OFF (SEND_EMAIL_ENABLED not true); every attempt still leaves its row in
// mail_sends (status 'off'), which is what this suite reads. Needs, on the server:
//   DEV_MODE=true EMAIL_CODE_SIGNIN_ENABLED=true APPLICATION_NOTIFICATION_EMAIL=team@example.test MAIL_WORKER_MS=2000
//   RESEND_WEBHOOK_SECRET=whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1 (the value below; a test value, never a real one)
//   plus the mock-SSO values of server/.env.example. Fresh DB; restart the server first.
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... node test/e2e-mail.mjs
// Never point this at production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, devCode, candidateLogin } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();
const SECRET = process.env.E2E_RESEND_WEBHOOK_SECRET || 'whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, extraHeaders = {}) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders };
      if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
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
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const stamp = Date.now();
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const sends = async (kind) => Number((await db.query(`SELECT count(*) FROM mail_sends WHERE kind = $1`, [kind])).rows[0].count);
const lastSend = async (kind) => (await db.query(`SELECT * FROM mail_sends WHERE kind = $1 ORDER BY id DESC LIMIT 1`, [kind])).rows[0];
const details = (n, extra = {}) => ({
  firstName: 'מייל', lastName: 'בדיקה', phoneNumber: `05${String(stamp + n).slice(-8)}`, citySymbol: 9000, gender: 'female',
  dateOfBirth: '1991-02-03T00:00:00.000Z', skills: [], consent: true, ...extra,
});
const sign = (id, ts, body) => {
  const key = Buffer.from(SECRET.slice(6), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
};
const webhook = (event, { id = `msg_${crypto.randomUUID()}`, ts = Math.floor(Date.now() / 1000), signature, raw } = {}) => {
  const body = raw ?? JSON.stringify(event);
  return jar().req('POST', '/api/webhooks/resend', body, {
    'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': signature ?? sign(id, ts, body),
  });
};

// ---- setup ----
const anon = jar();
const cm = jar(); const admin = jar(); const cand = jar();
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager');
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin');
const candEmail = `mail-cand-${stamp}@example.test`;
assert.equal((await signUp(cand, { ...details(1), email: candEmail })).status, 200, 'setup: candidate');
// A refused staff route signs the caller out (existing behaviour), so refusals are tried with a throwaway candidate.
const intruder = async () => { const c = jar(); assert.equal((await signUp(c, { ...details(Math.floor(Math.random() * 1e6) + 10), email: `mail-x-${crypto.randomUUID().slice(0, 8)}@example.test` })).status, 200); return c; };
await cm.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
const skills = (await anon.req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;
const createJob = (title) => cm.req('POST', '/api/jobs', {
  title, jobScope: ['FullTime'], companyName: 'E2E Mail', publishDate: new Date(Date.now() - 1000).toISOString(),
  citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
  isSponsored: false, isMarked: false, contactPersonEmail: `jobs-${stamp}@employer.test`,
});
const guestApply = (jobId, email) => anon.req('POST', '/api/jobs/guestApply', {
  jobData: { _id: jobId }, guestData: { fullName: 'אורח בדיקה', email, phoneNumber: '0504444444' }, consent: true,
});

// ---------------------------------------------------------------------------
await check('gates: no session and a candidate are refused; a content manager and an admin get the screen', async () => {
  assert.ok([400, 401, 403].includes((await anon.req('GET', '/api/admin/mail')).status));
  assert.ok([400, 401, 403].includes((await (await intruder()).req('GET', '/api/admin/mail')).status));
  assert.ok([400, 401, 403].includes((await (await intruder()).req('PUT', '/api/admin/mail/kinds/welcome/enabled', { enabled: false })).status));
  assert.equal((await admin.req('GET', '/api/admin/mail')).status, 200);
  const r = await cm.req('GET', '/api/admin/mail');
  assert.equal(r.status, 200, r.text);
  const kinds = r.json.data.events.map((e) => e.kind);
  for (const k of ['sign_in_code', 'welcome', 'application_received', 'application_forwarded', 'job_closed', 'employer_new_applicant',
    'submission_approved', 'submission_rejected', 'edit_request_approved', 'edit_request_rejected', 'staff_invite', 'staff_new_application', 'staff_job_submission']) {
    assert.ok(kinds.includes(k), k);
  }
  assert.equal(r.json.data.emailOn, false, 'run with email OFF');
  assert.equal(r.json.data.webhookConfigured, true, 'run with RESEND_WEBHOOK_SECRET');
});

await check('new candidate / employer events start off; the sign-in code is on and cannot be turned off (409)', async () => {
  const ev = Object.fromEntries((await cm.req('GET', '/api/admin/mail')).json.data.events.map((e) => [e.kind, e]));
  for (const k of ['application_received', 'application_forwarded', 'job_closed', 'submission_rejected', 'edit_request_approved']) assert.equal(ev[k].enabled, false, k);
  assert.equal(ev.sign_in_code.enabled, true); assert.equal(ev.sign_in_code.locked, true);
  const r = await cm.req('PUT', '/api/admin/mail/kinds/sign_in_code/enabled', { enabled: false });
  assert.equal(r.status, 409, r.text); assert.equal(r.json.code, 'mail_event_locked');
  assert.equal((await cm.req('PUT', '/api/admin/mail/kinds/nope/enabled', { enabled: true })).status, 404);
  assert.equal((await cm.req('PUT', '/api/admin/mail/kinds/welcome/enabled', { enabled: 'yes' })).status, 400);
});

let jobId = '';
await check('a turned-off event sends nothing; turned on, the same action sends (application_received, guest and registered)', async () => {
  const j = await createJob(`E2E mail ${stamp}`); assert.equal(j.status, 200, j.text); jobId = j.json.data.id;
  const before = await sends('application_received');
  const staffBefore = await sends('staff_new_application');
  assert.equal((await guestApply(jobId, `mail-g1-${stamp}@example.test`)).status, 200);
  await settle();
  assert.equal(await sends('application_received'), before, 'off → no attempt at all');
  assert.equal(await sends('staff_new_application'), staffBefore + 1, 'the team notice is on by default');
  const on = await cm.req('PUT', '/api/admin/mail/kinds/application_received/enabled', { enabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal((await guestApply(jobId, `mail-g2-${stamp}@example.test`)).status, 200);
  const reg = await cand.req('POST', `/api/jobs/apply/${jobId}`, { cv: { mode: 'profile' }, consent: true, marketingConsent: false });
  assert.ok([200, 201].includes(reg.status), reg.text);
  await settle();
  assert.equal(await sends('application_received'), before + 2, 'guest + registered');
  assert.equal((await lastSend('application_received')).status, 'off', 'email off: recorded, not sent');
  const off = await cm.req('PUT', '/api/admin/mail/kinds/application_received/enabled', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await guestApply(jobId, `mail-g3-${stamp}@example.test`)).status, 200);
  await settle();
  assert.equal(await sends('application_received'), before + 2, 'off again → nothing');
});

await check('templates: refused when invalid (unknown / missing required parameter, bad link, two-line subject)', async () => {
  const bad = async (kind, subject, body, code) => {
    const r = await cm.req('POST', `/api/admin/mail/kinds/${kind}/versions`, { subject, body });
    assert.equal(r.status, 400, r.text); assert.equal(r.json.code, 'mail_template_invalid');
    assert.ok(r.json.errors.some((e) => e.startsWith(code)), `${code}: ${r.json.errors}`);
  };
  await bad('sign_in_code', 'קוד', 'שלום {{firstName}} {{code}}', 'unknown_param:firstName');
  await bad('sign_in_code', 'קוד', 'אין פה קוד', 'missing_required:code');
  await bad('welcome', 'שלום', '[x](javascript:alert(1))', 'bad_link:');
  await bad('welcome', 'שורה\nשנייה', 'גוף', 'subject_multiline');
});

let v1 = ''; let v2 = '';
await check('versions: save a draft, publish, publish an older one, back to the default text; every version kept', async () => {
  const s1 = await cm.req('POST', '/api/admin/mail/kinds/welcome/versions', { subject: 'שלום {{firstName}} (גרסה 1)', body: 'ברוכים הבאים {{firstName}}' });
  assert.equal(s1.status, 201, s1.text); v1 = s1.json.data.id;
  let k = (await cm.req('GET', '/api/admin/mail/kinds/welcome')).json.data;
  assert.equal(k.current.versionId, null, 'a draft is not sent');
  const s2 = await cm.req('POST', '/api/admin/mail/kinds/welcome/versions', { subject: 'שלום {{firstName}} (גרסה 2)', body: 'ברוכים הבאים, {{firstName}}!', publish: true });
  assert.equal(s2.status, 201); v2 = s2.json.data.id;
  k = (await cm.req('GET', '/api/admin/mail/kinds/welcome')).json.data;
  assert.equal(k.current.versionId, v2);
  assert.ok(k.versions.length >= 2 && k.versions.find((v) => v.id === v1) && k.versions.find((v) => v.id === v2 && v.isPublished));
  assert.equal((await cm.req('POST', `/api/admin/mail/kinds/welcome/versions/${v1}/publish`)).status, 200);
  assert.equal((await cm.req('GET', '/api/admin/mail/kinds/welcome')).json.data.current.versionId, v1);
  // A version of another kind cannot be published here.
  assert.equal((await cm.req('POST', `/api/admin/mail/kinds/staff_invite/versions/${v1}/publish`)).status, 404);
  // The published template is the one used: a new sign-up records its version.
  assert.equal((await signUp(jar(), { ...details(2), email: `mail-cand2-${stamp}@example.test` })).status, 200);
  await settle();
  assert.equal(String((await lastSend('welcome')).template_version), v1);
  assert.equal((await cm.req('POST', '/api/admin/mail/kinds/welcome/reset')).status, 200);
  assert.equal((await cm.req('GET', '/api/admin/mail/kinds/welcome')).json.data.current.versionId, null);
  assert.ok((await cm.req('GET', '/api/admin/mail/kinds/welcome')).json.data.versions.length >= 2, 'history kept after reset');
});

await check('preview: sample values only, the template text escaped, errors listed', async () => {
  const r = await cm.req('POST', '/api/admin/mail/preview', { kind: 'application_received', subject: 'נושא {{jobTitle}}', body: 'שלום {{firstName}} <img src=x onerror=alert(1)>\n[[כפתור: למשרה | {{jobLink}}]]' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data.errors, []);
  assert.ok(!r.json.data.html.includes('<img'), 'escaped');
  assert.ok(r.json.data.html.includes('&lt;img'));
  assert.ok(r.json.data.html.includes('נועה'), 'the sample first name');
  assert.ok(!r.json.data.html.includes(candEmail));
  const e = await cm.req('POST', '/api/admin/mail/preview', { kind: 'application_received', subject: 'x', body: '{{code}}' });
  assert.ok(e.json.data.errors.includes('unknown_param:code'));
});

await check('test send: only to the editor (an address in the request is ignored), sample values, a test mark, logged without content', async () => {
  const before = await sends('job_closed');
  const r = await cm.req('POST', '/api/admin/mail/test', { kind: 'job_closed', subject: 'בדיקה {{jobTitle}}', body: 'שלום {{firstName}}', to: 'someone-else@example.test', email: 'x@example.test' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.to, 'self'); assert.equal(r.json.data.status, 'off');
  await settle();
  assert.equal(await sends('job_closed'), before + 1, 'recorded even though the event is off (a test is a forced send)');
  const a = (await db.query(`SELECT actor, target, details FROM audit_log WHERE action = 'mail.test_sent' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(a.target, 'job_closed');
  assert.ok(!JSON.stringify(a.details).includes('@') && !JSON.stringify(a.details).includes('בדיקה'), 'no address, no text');
  // Invalid templates are not sent either.
  assert.equal((await cm.req('POST', '/api/admin/mail/test', { kind: 'job_closed', subject: 'x', body: '{{code}}' })).status, 400);
});

await check('the sign-in code: a published template is used; a broken published one falls back to the default text', async () => {
  const s = await cm.req('POST', '/api/admin/mail/kinds/sign_in_code/versions', { subject: 'הקוד: {{code}}', body: '# {{code}}\nבתוקף {{minutes}} דקות.', publish: true });
  assert.equal(s.status, 201, s.text);
  const who = `mail-code-${stamp}@example.test`;
  assert.equal((await anon.req('POST', '/api/auth/email/request', { email: who })).status, 200);
  await settle();
  assert.equal(String((await lastSend('sign_in_code')).template_version), s.json.data.id);
  // Break it behind the screen's back (the screen never saves one without {{code}}).
  const bad = (await db.query(`INSERT INTO mail_template_versions (kind, subject, body, created_by) VALUES ('sign_in_code', 'no code', 'no code', 'e2e') RETURNING id`)).rows[0].id;
  await db.query(`UPDATE mail_events SET published_version = $1 WHERE kind = 'sign_in_code'`, [bad]);
  await settle(31_000); // the screen's 30-second cache
  const who2 = `mail-code2-${stamp}@example.test`;
  assert.equal((await anon.req('POST', '/api/auth/email/request', { email: who2 })).status, 200);
  await settle();
  const last = await lastSend('sign_in_code');
  assert.equal(last.template_version, null, 'default text used');
  assert.equal(last.status, 'off');
  assert.match(await devCode(jar(), who2), /^\d{6}$/, 'sign-in by code still works');
  assert.equal((await cm.req('POST', '/api/admin/mail/kinds/sign_in_code/reset')).status, 200);
});

await check('webhook: unsigned, wrongly signed or stale → 401, nothing changed', async () => {
  const ev = { type: 'email.bounced', data: { email_id: 'x', to: [`nobody-${stamp}@example.test`], bounce: { type: 'Permanent' } } };
  const before = Number((await db.query(`SELECT count(*) FROM mail_suppressions`)).rows[0].count);
  const noSig = await jar().req('POST', '/api/webhooks/resend', JSON.stringify(ev), { 'Content-Type': 'application/json' });
  assert.equal(noSig.status, 401, noSig.text);
  assert.equal((await webhook(ev, { signature: 'v1,' + Buffer.from('nope').toString('base64') })).status, 401);
  const old = Math.floor(Date.now() / 1000) - 600;
  assert.equal((await webhook(ev, { ts: old })).status, 401, 'stale');
  const body = JSON.stringify(ev);
  assert.equal((await webhook(ev, { raw: body + ' ', signature: sign('m1', Math.floor(Date.now() / 1000), body), id: 'm1' })).status, 401, 'changed body');
  assert.equal(Number((await db.query(`SELECT count(*) FROM mail_suppressions`)).rows[0].count), before);
});

const bounced = `mail-bounce-${stamp}@example.test`;
await check('webhook: a permanent bounce suppresses (hash only); a replay changes nothing twice; a temporary bounce does not', async () => {
  const id = `msg_${crypto.randomUUID()}`;
  const ev = { type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: `re_${stamp}`, to: [bounced], bounce: { type: 'Permanent', subType: 'General' } } };
  const r = await webhook(ev, { id });
  assert.equal(r.status, 200, r.text);
  const rows = (await db.query(`SELECT * FROM mail_suppressions`)).rows;
  assert.ok(!JSON.stringify(rows).includes('@'), 'no address stored');
  const n = rows.length;
  const again = await webhook(ev, { id });
  assert.equal(again.status, 200); assert.equal(again.json.data.duplicate, true);
  const a = (await db.query(`SELECT target, details FROM audit_log WHERE action = 'mail.suppressed' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.match(a.target, /^email:[0-9a-f]{16}$/); assert.ok(!JSON.stringify(a.details).includes('@'));
  const t = await webhook({ type: 'email.bounced', data: { email_id: 'y', to: [`mail-soft-${stamp}@example.test`], bounce: { type: 'Transient' } } });
  assert.equal(t.status, 200);
  assert.equal((await db.query(`SELECT count(*) FROM mail_suppressions`)).rows[0].count, String(n), 'temporary bounce: not suppressed');
});

await check('a suppressed address gets nothing (sign-in code → suppressed, logged as a failed send); removing it sends again', async () => {
  assert.equal((await anon.req('POST', '/api/auth/email/request', { email: bounced })).status, 200, 'the same neutral answer');
  await settle(600);
  assert.equal((await lastSend('sign_in_code')).status, 'suppressed');
  const f = (await db.query(`SELECT details FROM audit_log WHERE action = 'auth.email_code_send_failed' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(f.details.error, 'suppressed');
  assert.ok([400, 401, 403].includes((await (await intruder()).req('POST', '/api/admin/mail/suppressions/remove', { email: bounced })).status), 'candidates may not');
  const r = await cm.req('POST', '/api/admin/mail/suppressions/remove', { email: bounced });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.data.removed, true);
  assert.equal((await cm.req('POST', '/api/admin/mail/suppressions/remove', { email: bounced })).json.data.removed, false);
  await settle(61_000); // the per-address minute between codes
  assert.equal((await anon.req('POST', '/api/auth/email/request', { email: bounced })).status, 200);
  await settle(600);
  assert.equal((await lastSend('sign_in_code')).status, 'off', 'sent again (email off locally)');
});

await check('webhook: delivered / complaint update the send record; a complaint suppresses', async () => {
  const rid = `re_e2e_${stamp}`;
  await db.query(`INSERT INTO mail_sends (kind, status, resend_id) VALUES ('welcome', 'sent', $1)`, [rid]);
  assert.equal((await webhook({ type: 'email.delivered', data: { email_id: rid, to: ['x@example.test'] } })).status, 200);
  assert.equal((await db.query(`SELECT status FROM mail_sends WHERE resend_id = $1`, [rid])).rows[0].status, 'delivered');
  const before = Number((await db.query(`SELECT count(*) FROM mail_suppressions`)).rows[0].count);
  assert.equal((await webhook({ type: 'email.complained', data: { email_id: rid, to: [`mail-spam-${stamp}@example.test`] } })).status, 200);
  assert.equal((await db.query(`SELECT status FROM mail_sends WHERE resend_id = $1`, [rid])).rows[0].status, 'complained');
  assert.equal(Number((await db.query(`SELECT count(*) FROM mail_suppressions`)).rows[0].count), before + 1);
});

await check('job closed: off → nothing; on → the applicants of a job archived after that, once per job', async () => {
  const before = await sends('job_closed');
  const j1 = await createJob(`E2E mail closed-off ${stamp}`); const id1 = j1.json.data.id;
  assert.equal((await guestApply(id1, `mail-c1-${stamp}@example.test`)).status, 200);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${id1}/archive`)).status, 200);
  await settle(5000);
  assert.equal(await sends('job_closed'), before, 'event off');
  assert.equal((await cm.req('PUT', '/api/admin/mail/kinds/job_closed/enabled', { enabled: true })).status, 200);
  await settle(5000);
  assert.equal(await sends('job_closed'), before, 'a job closed before the event was turned on is never mailed');
  const j2 = await createJob(`E2E mail closed-on ${stamp}`); const id2 = j2.json.data.id;
  assert.equal((await guestApply(id2, `mail-c2-${stamp}@example.test`)).status, 200);
  assert.equal((await guestApply(id2, `mail-c3-${stamp}@example.test`)).status, 200);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${id2}/archive`)).status, 200);
  await settle(35_000); // the cache, the worker's interval and its pace
  assert.equal(await sends('job_closed'), before + 2, 'both applicants');
  assert.equal((await db.query(`SELECT notified FROM mail_job_closed WHERE job_id = $1`, [id2])).rows[0]?.notified, 2);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${id2}/restore`)).status, 200);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${id2}/archive`)).status, 200);
  await settle(6000);
  assert.equal(await sends('job_closed'), before + 2, 'once per job');
  await cm.req('PUT', '/api/admin/mail/kinds/job_closed/enabled', { enabled: false });
});

// ---- every event on every path (23.11.2026: an existing account given a staff role got no invite) ----------------
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const phone = () => `05${String(crypto.randomInt(1e7, 1e8))}`;
const kindOn = (kind, enabled) => cm.req('PUT', `/api/admin/mail/kinds/${kind}/enabled`, { enabled });
const employerSignUp = async (client, email) => {
  const code = await devCode(client, email);
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  assert.equal(v.json?.data?.status, 'signup', v.text);
  const r = await client.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה מיילים', phone: phone(),
    jobTitle: 'מגייסת', consent: true, marketingConsent: false,
  });
  assert.equal(r.status, 200, r.text);
  return r.json.data.user._id ?? r.json.data.user.id;
};
const form = (title, contactEmail) => ({
  title, companyName: 'חברת מיילים', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skillId],
  description: `תיאור ארוך מספיק של משרה לבדיקת המיילים ${stamp}.`, externalLink: '', publicEmail: `apply-${stamp}@example.test`,
  contactName: 'דנה מעסיקה', contactEmail, contactPhone: '050-1234567', consent: true, website: '',
});
const empEmail = `mail-emp-${stamp}@example.test`;
let emp = jar(); let empId = '';

await check('staff invite: a new address, an existing candidate and an existing employer each get one; a role change none; off → none', async () => {
  const n0 = await sends('staff_invite');
  const a = await admin.req('POST', '/api/admin/staff', { email: `mail-staff-${stamp}@example.test`, role: 'placement_coordinator' });
  assert.equal(a.status, 200, a.text); assert.equal(a.json.data.created, true);
  assert.equal(await sends('staff_invite'), n0 + 1, 'a new address');
  const c = jar(); const cEmail = `mail-cand2staff-${stamp}@example.test`;
  assert.equal((await signUp(c, { ...details(20), email: cEmail })).status, 200);
  const b = await admin.req('POST', '/api/admin/staff', { email: cEmail, role: 'content_manager' });
  assert.equal(b.status, 200, b.text); assert.equal(b.json.data.created, false);
  assert.equal(await sends('staff_invite'), n0 + 2, 'an existing candidate');
  empId = await employerSignUp(emp, empEmail);
  const e = await admin.req('POST', '/api/admin/staff', { email: empEmail, role: 'placement_coordinator' });
  assert.equal(e.status, 200, e.text);
  assert.equal(await sends('staff_invite'), n0 + 3, 'an existing employer');
  assert.deepEqual([...(await db.query(`SELECT roles FROM users WHERE id = $1`, [empId])).rows[0].roles].sort(), ['employer', 'placement_coordinator']);
  // A staff member whose staff role changes (either screen path) gets no invite.
  assert.equal((await admin.req('POST', '/api/admin/staff', { email: cEmail, role: 'placement_coordinator' })).status, 200);
  const sid = (await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [cEmail])).rows[0].id;
  assert.equal((await admin.req('PATCH', `/api/admin/staff/${sid}/role`, { role: 'content_manager' })).status, 200);
  assert.equal(await sends('staff_invite'), n0 + 3, 'role changes send nothing');
  assert.equal((await kindOn('staff_invite', false)).status, 200);
  assert.equal((await admin.req('POST', '/api/admin/staff', { email: `mail-staff-off-${stamp}@example.test`, role: 'content_manager' })).status, 200);
  assert.equal(await sends('staff_invite'), n0 + 3, 'off → nothing');
  assert.equal((await kindOn('staff_invite', true)).status, 200);
  // The staff role closed the employer's sessions: sign in again by code (an employer + staff account may).
  emp = jar(); assert.equal((await candidateLogin(emp, empEmail)).status, 200);
});

await check('welcome: a sign-up and a candidate role added to an employer account each send one; an employer sign-up none; off → none', async () => {
  const n0 = await sends('welcome');
  assert.equal((await signUp(jar(), { ...details(30), email: `mail-w1-${stamp}@example.test` })).status, 200);
  assert.equal(await sends('welcome'), n0 + 1, 'a sign-up');
  const e2 = jar(); await employerSignUp(e2, `mail-emp2-${stamp}@example.test`);
  assert.equal(await sends('welcome'), n0 + 1, 'an employer is not a candidate');
  const add = await e2.req('POST', '/api/users/me/roles/candidate', {
    firstName: 'אלה', lastName: 'מעסיקה', phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other',
    citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(add.status, 200, add.text);
  await settle();
  assert.equal(await sends('welcome'), n0 + 2, 'the candidate role added');
  assert.equal((await kindOn('welcome', false)).status, 200);
  assert.equal((await signUp(jar(), { ...details(31), email: `mail-w2-${stamp}@example.test` })).status, 200);
  assert.equal(await sends('welcome'), n0 + 2, 'off → nothing');
  assert.equal((await kindOn('welcome', true)).status, 200);
});

let empJobId = '';
await check('employer form: the team notice on every submission (anonymous, an employer account); decisions only when on', async () => {
  const t0 = await sends('staff_job_submission'); const ap0 = await sends('submission_approved'); const rj0 = await sends('submission_rejected');
  const T1 = `E2E-M1-${stamp}`.slice(0, 30), T2 = `E2E-M2-${stamp}`.slice(0, 30), T3 = `E2E-M3-${stamp}`.slice(0, 30);
  for (const [client, t] of [[anon, T1], [anon, T2], [emp, T3]]) {
    const r = await client.req('POST', '/api/job-submissions', form(t, `contact-${stamp}@example.test`));
    assert.equal(r.status, 201, `${t}: ${r.text}`);
  }
  await settle();
  assert.equal(await sends('staff_job_submission'), t0 + 3, 'one team notice per submission');
  const items = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items;
  const idOf = (t) => items.find((x) => x.title === t).id;
  assert.equal((await cm.req('POST', `/api/admin/job-submissions/${idOf(T1)}/reject`, { reason: 'לא מתאים' })).status, 200);
  await settle();
  assert.equal(await sends('submission_rejected'), rj0, 'off → nothing');
  assert.equal((await kindOn('submission_rejected', true)).status, 200);
  assert.equal((await kindOn('submission_approved', true)).status, 200);
  assert.equal((await cm.req('POST', `/api/admin/job-submissions/${idOf(T2)}/reject`, { reason: 'לא מתאים' })).status, 200);
  const ap = await cm.req('POST', `/api/admin/job-submissions/${idOf(T3)}/approve`, {});
  assert.equal(ap.status, 200, ap.text); empJobId = ap.json.data.jobId;
  await settle();
  assert.equal(await sends('submission_rejected'), rj0 + 1, 'rejected, on');
  assert.equal(await sends('submission_approved'), ap0 + 1, 'approved, on');
});

await check('forward and edit requests: the candidate and the employer (who is also staff) each get theirs', async () => {
  for (const k of ['application_forwarded', 'employer_new_applicant', 'edit_request_approved', 'edit_request_rejected']) assert.equal((await kindOn(k, true)).status, 200, k);
  const f0 = await sends('application_forwarded'); const n0 = await sends('employer_new_applicant');
  const reg = await cand.req('POST', `/api/jobs/apply/${empJobId}`, { cv: { mode: 'profile' }, consent: true, marketingConsent: false });
  assert.ok([200, 201].includes(reg.status), reg.text);
  const appId = (await db.query(`SELECT a.id FROM job_applications a JOIN users u ON u.id = a.user_id WHERE a.job_id = $1 AND lower(u.email) = $2`, [empJobId, candEmail])).rows[0].id;
  const fw = await cm.req('POST', '/api/admin/employer-forwards', { kind: 'application', applicationId: appId });
  assert.ok([200, 201].includes(fw.status), fw.text);
  await settle();
  assert.equal(await sends('application_forwarded'), f0 + 1, 'the candidate');
  assert.equal(await sends('employer_new_applicant'), n0 + 1, 'the employer, whose primary role is staff');
  const r0 = await sends('edit_request_rejected'); const a0 = await sends('edit_request_approved');
  const p = `/api/employer/jobs/${empJobId}/edit-requests`;
  const r1 = await emp.req('POST', p, { title: `E2E-M3b-${stamp}`.slice(0, 30) });
  assert.ok([200, 201].includes(r1.status), r1.text);
  const id1 = (r1.json.data.id ?? r1.json.data.requestId);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${id1}/reject`, { reason: 'לא ברור' })).status, 200);
  const r2 = await emp.req('POST', p, { title: `E2E-M3c-${stamp}`.slice(0, 30) });
  assert.ok([200, 201].includes(r2.status), r2.text);
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${r2.json.data.id ?? r2.json.data.requestId}/approve`, {})).status, 200);
  await settle();
  assert.equal(await sends('edit_request_rejected'), r0 + 1, 'rejected');
  assert.equal(await sends('edit_request_approved'), a0 + 1, 'approved');
});

await check('the screen: the 30-day counts match the send records for every kind', async () => {
  const d = (await cm.req('GET', '/api/admin/mail')).json.data;
  const rows = (await db.query(`SELECT kind, status, count(*)::int AS n FROM mail_sends WHERE created_at > now() - interval '30 days' GROUP BY kind, status`)).rows;
  for (const r of rows) assert.equal(d.stats[r.kind]?.[r.status], r.n, `${r.kind}/${r.status}`);
  assert.equal(d.teamInboxSet, true);
});

await check('every change on the screen is logged with ids only; send records hold no address', async () => {
  const rows = (await db.query(`SELECT action, actor, target, details FROM audit_log WHERE action LIKE 'mail.%' AND at > now() - interval '1 hour'`)).rows;
  for (const a of ['mail.event_enabled', 'mail.event_disabled', 'mail.template_saved', 'mail.template_published', 'mail.template_reset', 'mail.test_sent', 'mail.suppression_removed', 'mail.suppressed']) {
    assert.ok(rows.some((r) => r.action === a), `${a} logged`);
  }
  for (const r of rows) assert.ok(!JSON.stringify(r.details ?? {}).includes('@') && !String(r.target).includes('@'), `${r.action}: an address`);
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_sends'`)).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /mail_to|address|recipient|subject|body/.test(c)), cols.join(','));
});

await db.end();
for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
