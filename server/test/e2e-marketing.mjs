// Marketing consent per candidate and the removal list (docs/marketing-consent.md), end to end against a LOCAL server.
// No marketing mail exists yet; this checks the states, who may change them, the one-click link and the log.
// The suite signs unsubscribe tokens itself, so it needs the server's secret (the dev value from server/.env.example):
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... RESET_TOKEN_SECRET=<the server's> \
//   RESEND_WEBHOOK_SECRET=<the server's, optional: the complaint check> node test/e2e-marketing.mjs
// Fresh DB; restart the server first (it spends per-IP sign-up limits). Never point this at production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, devCode } from './helpers/candidate.mjs';
(await import('dotenv')).config();
const { emailKey } = await import('../dist/security/emailCode.js');
const { unsubscribeToken } = await import('../dist/security/marketing.js');

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';

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
let n = 0;
const details = (extra = {}) => ({
  firstName: 'דיוור', lastName: 'בדיקה', phoneNumber: `05${String(stamp + (++n) * 7919).slice(-8)}`, citySymbol: 9000, gender: 'female',
  dateOfBirth: '1991-02-03T00:00:00.000Z', skills: [], consent: true, ...extra,
});
const addr = (k) => `mk-${k}-${stamp}@example.test`;
const newCandidate = async (k, marketingConsent) => {
  const c = jar(); const email = addr(k);
  const r = await signUp(c, { ...details({ marketingConsent }), email });
  assert.equal(r.status, 200, `sign-up ${k}: ${r.text}`);
  return { c, email, id: String(r.json.data._id) };
};
const OK_REFUSED = [400, 401, 403];
const statusOf = async (staff, id) => {
  const r = await staff.req('GET', `/api/admin/users/${id}/marketing`);
  assert.equal(r.status, 200, r.text);
  return r.json.data;
};
// The lasting lists have their own key since 24.11.2026 (security/addressKey.ts); rows made with the old one still count.
const { addressKeys } = await import('../dist/security/addressKey.js');
const optoutRow = async (email) => (await db.query(`SELECT * FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [addressKeys(email)])).rows[0];

// ---- setup ----
const cm = jar(); const admin = jar(); const co = jar();
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager');
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin');
const CO_EMAIL = addr('coordinator');
assert.equal((await admin.req('POST', '/api/admin/staff', { email: CO_EMAIL, role: 'placement_coordinator', firstName: 'רכזת', lastName: 'בדיקה' })).status, 200, 'setup: coordinator invited');
assert.equal((await staffLogin(co, CO_EMAIL)).status, 200, 'setup: coordinator');

// ---------------------------------------------------------------------------
let yes; let no;
await check('sign-up: the box ticked → agreed, left empty → not agreed; the source and a consent record each', async () => {
  yes = await newCandidate('yes', true);
  no = await newCandidate('no', false);
  const a = await statusOf(cm, yes.id); const b = await statusOf(cm, no.id);
  assert.equal(a.status, 'agreed'); assert.equal(a.source, 'signup');
  assert.equal(b.status, 'not_agreed'); assert.equal(b.source, 'signup');
  assert.equal(a.history.length, 1); assert.equal(a.history[0].marketing, true);
  const old = await newCandidate('old', false);
  await db.query(`UPDATE users SET marketing_consent = NULL, marketing_consent_source = NULL WHERE id = $1`, [old.id]);
  assert.equal((await statusOf(cm, old.id)).status, 'unknown', 'never asked');
});

await check('personal area: "no" puts the address on the removal list; the person\'s own "yes" clears it', async () => {
  let r = await yes.c.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: false });
  assert.equal(r.status, 200, r.text);
  let s = await statusOf(cm, yes.id);
  assert.equal(s.status, 'removed'); assert.equal(s.removal.via, 'personal_area');
  assert.ok(await optoutRow(yes.email));
  r = await yes.c.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: true });
  assert.equal(r.status, 200);
  s = await statusOf(cm, yes.id);
  assert.equal(s.status, 'agreed'); assert.equal(s.removal, null);
  assert.equal(await optoutRow(yes.email), undefined);
  assert.deepEqual(s.history.slice(0, 3).map((h) => [h.marketing, h.source]), [[true, 'personal_area'], [false, 'personal_area'], [true, 'signup']]);
});

await check('the unsubscribe link: signed token only; the same answer with or without an account; a bad token changes nothing', async () => {
  const bad = await jar().req('POST', `/api/unsubscribe?t=${encodeURIComponent('abc.def')}`);
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'unsubscribe_invalid');
  const forged = unsubscribeToken({ k: emailKey(yes.email), u: yes.id }, { EMAIL_CODE_SECRET: 'not-the-server-secret-0000' });
  assert.equal((await jar().req('POST', `/api/unsubscribe?t=${encodeURIComponent(forged)}`)).status, 400, 'signed with another secret');
  assert.equal((await statusOf(cm, yes.id)).status, 'agreed', 'nothing changed');
  // RFC 8058: a mail client POSTs "List-Unsubscribe=One-Click" (form body), no cookies.
  const t = unsubscribeToken({ k: emailKey(yes.email), u: yes.id });
  const r = await jar().req('POST', `/api/unsubscribe?t=${encodeURIComponent(t)}`, 'List-Unsubscribe=One-Click', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 200, r.text);
  const s = await statusOf(cm, yes.id);
  assert.equal(s.status, 'removed'); assert.equal(s.removal.via, 'link'); assert.equal(s.source, 'unsubscribe_link');
  const stranger = unsubscribeToken({ k: emailKey(addr('no-account')) });
  const r2 = await jar().req('POST', '/api/unsubscribe', { t: stranger });
  assert.equal(r2.status, 200); assert.equal(r2.text, r.text, 'the same answer');
  assert.ok(await optoutRow(addr('no-account')), 'an address without an account is kept (hashed)');
  const again = await jar().req('POST', `/api/unsubscribe?t=${encodeURIComponent(t)}`);
  assert.equal(again.status, 200); assert.equal(again.text, r.text, 'already removed: the same answer');
});

await check('a removal beats any later "yes" that is not the person\'s own signed-in answer (quick application, re-apply)', async () => {
  // A quick application (no account, unverified address) with the box ticked does not reverse the removal.
  const skills = (await jar().req('GET', '/api/skills')).json.data;
  const skillId = (skills.skills ?? skills)[0]._id;
  await cm.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
  const job = await cm.req('POST', '/api/jobs', {
    title: `E2E marketing ${stamp}`, jobScope: ['FullTime'], companyName: 'E2E Marketing', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId], isSponsored: false, isMarked: false,
  });
  assert.equal(job.status, 200, job.text);
  const g = await jar().req('POST', '/api/jobs/guestApply', {
    jobData: { _id: job.json.data.id }, guestData: { fullName: 'אורח', email: yes.email, phoneNumber: '0504444444' }, consent: true, marketingConsent: true,
  });
  assert.equal(g.status, 200, g.text);
  assert.equal((await statusOf(cm, yes.id)).status, 'removed');
  assert.ok(await optoutRow(yes.email));
  // Applying while signed in does not ask again (already answered), so nothing changes either.
  const ap = await yes.c.req('POST', `/api/jobs/apply/${job.json.data.id}`, { cv: { mode: 'profile' }, consent: true, marketingConsent: true });
  assert.ok([200, 201].includes(ap.status), ap.text);
  assert.equal((await statusOf(cm, yes.id)).status, 'removed');
});

await check('staff: a content manager records a removal on request; nobody can mark someone as agreed', async () => {
  const r = await cm.req('POST', `/api/admin/users/${no.id}/marketing-optout`);
  assert.equal(r.status, 200, r.text);
  const s = await statusOf(cm, no.id);
  assert.equal(s.status, 'removed'); assert.equal(s.removal.via, 'staff'); assert.equal(s.source, 'staff_on_request');
  // No way in: the staff edit of a candidate ignores it, and there is no opt-in route.
  const p = await cm.req('PATCH', `/api/users/${no.id}`, { marketingConsent: true, marketing_consent: true, firstName: 'דיוור' });
  assert.ok(p.status < 500, p.text);
  assert.equal((await statusOf(cm, no.id)).status, 'removed');
  for (const path of [`/api/admin/users/${no.id}/marketing-optin`, `/api/admin/users/${no.id}/marketing`]) {
    const x = await cm.req('POST', path, { marketing: true, status: 'agreed' });
    assert.ok([404, 405].includes(x.status), `${path}: ${x.status}`);
  }
  assert.equal((await statusOf(cm, no.id)).status, 'removed');
  // An admin may too (an admin can do all a content manager can).
  const other = await newCandidate('admin-removes', true);
  assert.equal((await admin.req('POST', `/api/admin/users/${other.id}/marketing-optout`)).status, 200);
  assert.equal((await statusOf(cm, other.id)).status, 'removed');
});

await check('staff: an address without an account; its later sign-up keeps the removal unless that person ticks "yes"', async () => {
  const later = addr('later'); const later2 = addr('later2');
  for (const e of [later, later2]) {
    const r = await cm.req('POST', '/api/admin/marketing/optouts', { email: e.toUpperCase() });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal((await cm.req('POST', '/api/admin/marketing/optouts', { email: 'not-an-email' })).status, 400);
  const c1 = jar(); const s1 = await signUp(c1, { ...details({ marketingConsent: false }), email: later });
  assert.equal(s1.status, 200, s1.text);
  assert.equal((await statusOf(cm, s1.json.data._id)).status, 'removed', 'the removal shows on the new account');
  const c2 = jar(); const s2 = await signUp(c2, { ...details({ marketingConsent: true }), email: later2 });
  assert.equal(s2.status, 200);
  assert.equal((await statusOf(cm, s2.json.data._id)).status, 'agreed', 'their own verified "yes" at sign-up');
  assert.equal(await optoutRow(later2), undefined);
});

await check('coordinator: sees the state and history, cannot record a removal', async () => {
  const t = await newCandidate('co-view', true);
  assert.equal((await statusOf(co, t.id)).status, 'agreed');
  const r = await co.req('POST', `/api/admin/users/${t.id}/marketing-optout`);
  assert.ok(OK_REFUSED.includes(r.status), `${r.status}`);
  assert.equal((await statusOf(cm, t.id)).status, 'agreed');
});

await check('candidates and employers get nothing (refused on every staff marketing route)', async () => {
  const cand = await newCandidate('intruder', true);
  assert.ok(OK_REFUSED.includes((await cand.c.req('GET', `/api/admin/users/${yes.id}/marketing`)).status));
  const emp = jar(); const email = addr('employer');
  const code = await devCode(emp, email);
  const v = await emp.req('POST', '/api/auth/email/verify', { email, code });
  assert.equal(v.json?.data?.status, 'signup', v.text);
  const su = await emp.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: `05${String(stamp + 99).slice(-8)}`,
    jobTitle: 'מגייסת', consent: true, marketingConsent: false,
  });
  assert.equal(su.status, 200, su.text);
  assert.ok(OK_REFUSED.includes((await emp.req('GET', `/api/admin/users/${yes.id}/marketing`)).status));
  const emp2 = jar(); const c2 = await devCode(emp2, email);
  await emp2.req('POST', '/api/auth/email/verify', { email, code: c2 });
  assert.ok(OK_REFUSED.includes((await emp2.req('POST', '/api/admin/marketing/optouts', { email: yes.email })).status));
  const emp3 = jar(); const c3 = await devCode(emp3, email);
  await emp3.req('POST', '/api/auth/email/verify', { email, code: c3 });
  const ea = await emp3.req('GET', '/api/employer/applicants');
  assert.ok(!/marketing/i.test(ea.text), 'no marketing data in the employer area');
});

await check('the candidates list: a "marketing" column and filter, through the hand-over', async () => {
  const q = (s) => cm.req('GET', `/api/users?usersFilter[marketing]=${s}&usersFilter[inputValue]=${encodeURIComponent(`mk-`)}&usersFilter[limit]=50`);
  const removed = await q('removed');
  assert.equal(removed.status, 200, removed.text);
  assert.ok(removed.json.data.users.length >= 2);
  assert.ok(removed.json.data.users.every((u) => u.marketing?.status === 'removed'));
  assert.ok(removed.json.data.users.some((u) => u._id === no.id || u.id === no.id));
  const agreed = (await q('agreed')).json.data.users;
  assert.ok(agreed.length >= 1 && agreed.every((u) => u.marketing.status === 'agreed'));
  const all = (await cm.req('GET', `/api/users?usersFilter[inputValue]=mk-&usersFilter[limit]=50`)).json.data.users;
  assert.ok(all.length > agreed.length, 'no filter → everyone');
  const logged = (await db.query(`SELECT 1 FROM audit_log WHERE action = 'candidates.shown' AND details->'filters'->>'marketing' = 'removed'`)).rows;
  assert.ok(logged.length >= 1, 'the filter is in the hand-over log entry');
});

await check('a spam complaint (Resend webhook) removes the address from marketing', async () => {
  if (!WEBHOOK_SECRET) throw new Error('set RESEND_WEBHOOK_SECRET (the server\'s) to run this check');
  const t = await newCandidate('complains', true);
  const body = JSON.stringify({ type: 'email.complained', data: { email_id: `re_${stamp}`, to: [t.email] } });
  const id = `msg_${crypto.randomUUID()}`; const ts = Math.floor(Date.now() / 1000);
  const sig = `v1,${crypto.createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
  const r = await jar().req('POST', '/api/webhooks/resend', body, { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig });
  assert.equal(r.status, 200, r.text);
  const s = await statusOf(cm, t.id);
  assert.equal(s.status, 'removed'); assert.equal(s.removal.via, 'complaint');
});

await check('the log and the removal list hold ids and hashes only, never an address', async () => {
  const rows = (await db.query(`SELECT action, actor, target, details FROM audit_log WHERE (action LIKE 'marketing.%' OR action = 'user.marketing_consent_changed') AND at > now() - interval '1 hour'`)).rows;
  for (const a of ['marketing.removed_by_staff', 'marketing.unsubscribed', 'user.marketing_consent_changed']) assert.ok(rows.some((r) => r.action === a), `${a} logged`);
  for (const r of rows) {
    assert.ok(!String(r.target).includes('@') && !JSON.stringify(r.details ?? {}).includes('@'), `${r.action}: an address`);
    if (r.action.startsWith('marketing.')) assert.match(String(r.target), /^(user:[0-9a-f]{24}|email:[0-9a-f]{16})$/);
  }
  const strict = rows.filter((r) => r.action === 'marketing.removed_by_staff');
  assert.ok(strict.every((r) => r.actor !== 'anonymous'));
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'marketing_optouts'`)).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /^email$|address/.test(c)), cols.join(','));
  const sources = (await db.query(`SELECT DISTINCT source FROM consent_records WHERE marketing IS NOT NULL`)).rows.map((r) => r.source);
  for (const s of ['signup', 'personal_area', 'unsubscribe_link', 'staff_on_request']) assert.ok(sources.includes(s), s);
});

await db.end();
for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
