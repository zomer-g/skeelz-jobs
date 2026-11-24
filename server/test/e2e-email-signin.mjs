// "קבלת קוד למייל" end to end, against a running LOCAL server (DEV_MODE=true, SEND_EMAIL_ENABLED not true: nothing is
// sent; the codes are read from the DEV_MODE-only /api/dev/email-code). Uses DATABASE_URL (server/.env) to look at
// the stored rows and to age a code. Run on a fresh server (it spends per-address limits):
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... node test/e2e-email-signin.mjs
// Never point this at production.
import assert from 'node:assert/strict';
import pg from 'pg';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, candidateLogin, devCode, lastSentCode } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();

const jar = () => {
  const cookies = new Map();
  return {
    cookies,
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
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const stamp = Date.now();
const addr = (k) => `es-${k}-${stamp}@example.test`;
const request = (email, c = jar()) => c.req('POST', '/api/auth/email/request', { email });
const verify = (email, code, c = jar()) => c.req('POST', '/api/auth/email/verify', { email, code });
const wrongOf = (code) => String((Number(code) + 1) % 1e6).padStart(6, '0');
const settle = () => new Promise((r) => setTimeout(r, 300)); // fire-and-forget log writes
const details = (n, extra = {}) => ({
  firstName: 'מייל', lastName: 'קוד', phoneNumber: `05${String(stamp + n).slice(-8)}`, citySymbol: 9000, gender: 'female',
  dateOfBirth: '1991-02-03T00:00:00.000Z', skills: [], consent: true, ...extra,
});

// Setup: an existing candidate, and a deactivated one.
const existing = addr('existing');
const off = addr('off');
assert.equal((await signUp(jar(), { ...details(1), email: existing })).status, 200, 'setup: candidate');
assert.equal((await signUp(jar(), { ...details(2), email: off })).status, 200, 'setup: second candidate');
await db.query(`UPDATE users SET deactivated_at = now() WHERE lower(email) = $1`, [off]);
const staffJar = jar();
assert.equal((await staffLogin(staffJar, ADMIN_EMAIL)).status, 200, 'setup: admin');

// ---------------------------------------------------------------------------
await check('an invalid address is refused (400 au16); nothing stored', async () => {
  for (const email of ['', 'no-at', 'a@b', ' @x.co']) {
    const r = await request(email);
    assert.equal(r.status, 400, email); assert.equal(r.json.code, 'au16');
  }
});

const fresh = addr('new');
let answer;
await check('the same answer for a new address, a candidate, staff (both roles) and a deactivated account', async () => {
  const out = [];
  for (const email of [fresh, existing, ADMIN_EMAIL, CM_EMAIL, off]) {
    const r = await request(email);
    assert.equal(r.status, 200, `${email}: ${r.text}`);
    out.push(r.text);
  }
  assert.equal(new Set(out).size, 1, out.join(' | '));
  answer = JSON.parse(out[0]).data;
  assert.equal(answer.resendAfter, 60); assert.equal(answer.validMinutes, 10);
  assert.ok(!/exist|staff|regist/i.test(answer.message.replace('If this address can sign in here', '')), answer.message);
});
await check('a code goes to the new address and the candidate; none to staff or the deactivated account', async () => {
  await settle();
  assert.match(String(await lastSentCode(jar(), fresh)), /^\d{6}$/);
  assert.match(String(await lastSentCode(jar(), existing)), /^\d{6}$/);
  for (const email of [ADMIN_EMAIL, CM_EMAIL, off]) assert.equal(await lastSentCode(jar(), email), null, email);
});
await check('60 seconds between codes, the same 429 for every address (au14, Retry-After)', async () => {
  const out = [];
  for (const email of [fresh, existing, ADMIN_EMAIL]) {
    const r = await request(email);
    assert.equal(r.status, 429, `${email}: ${r.text}`); assert.equal(r.json.code, 'au14');
    assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 60);
    out.push(r.json.code);
  }
  assert.equal(new Set(out).size, 1);
});
await check('stored rows hold no address and no code (keyed hashes only)', async () => {
  const code = await lastSentCode(jar(), fresh);
  const rows = (await db.query(`SELECT * FROM email_codes WHERE created_at > now() - interval '5 minutes'`)).rows;
  assert.ok(rows.length >= 5, `${rows.length} rows`);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('@') && !text.includes(code), 'an address or a code is stored in clear');
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.email_key) && /^[0-9a-f]{64}$/.test(r.code_hash)));
});

let freshCode;
await check('a wrong code: 400 au12 with the tries left; the code stays usable', async () => {
  freshCode = await lastSentCode(jar(), fresh);
  const r = await verify(fresh, wrongOf(freshCode));
  assert.equal(r.status, 400); assert.equal(r.json.code, 'au12'); assert.equal(r.json.attemptsLeft, 4);
  for (const bad of ['12345', 'abcdef', '']) assert.equal((await verify(fresh, bad)).json.code, 'au12');
});
const pending = jar();
await check('the right code for a new address → the sign-up form (signed cookie); nothing created yet', async () => {
  const r = await verify(fresh, ` ${freshCode.slice(0, 3)} ${freshCode.slice(3)} `, pending);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.data, { status: 'signup', email: fresh });
  assert.ok(pending.cookies.has('email_signup'));
  assert.ok(!pending.cookies.has('access_token'), 'signed in before the form');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [fresh])).rows[0].n, 0);
  const p = await pending.req('GET', '/api/auth/email/signup');
  assert.equal(p.json.data.email, fresh);
});
await check('single use: the same code again is refused', async () => {
  const r = await verify(fresh, freshCode);
  assert.equal(r.status, 400); assert.equal(r.json.code, 'au12');
});
await check('the sign-up form: consent required, the same required details, the email only from the cookie', async () => {
  const noTerms = await pending.req('POST', '/api/auth/email/signup', details(3, { consent: undefined }));
  assert.equal(noTerms.status, 400); assert.equal(noTerms.json.code, 'terms_required');
  const missing = await pending.req('POST', '/api/auth/email/signup', { firstName: 'x', lastName: 'y', consent: true });
  assert.equal(missing.status, 400);
  const evil = addr('evil');
  const r = await pending.req('POST', '/api/auth/email/signup', details(3, { email: evil, role: 'admin', password: 'x', marketingConsent: false }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.email, fresh); assert.equal(r.json.data.user.role, 'user');
  assert.equal(r.json.data.user.password, undefined);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [evil])).rows[0].n, 0);
  const row = (await db.query(`SELECT role, password, terms_version, marketing_consent FROM users WHERE lower(email) = $1`, [fresh])).rows[0];
  assert.deepEqual([row.role, row.password, !!row.terms_version, row.marketing_consent], ['user', '', true, false]);
  assert.equal((await pending.req('GET', '/api/auth/session')).json.data.user.email, fresh, 'not signed in after the form');
  // the pending cookie is spent
  assert.equal((await pending.req('POST', '/api/auth/email/signup', details(4))).status, 401);
});
await check('without (or with a forged) sign-up cookie the form is refused (401 au15)', async () => {
  const r = await jar().req('POST', '/api/auth/email/signup', details(5));
  assert.equal(r.status, 401); assert.equal(r.json.code, 'au15');
  const forged = jar();
  forged.setCookie('email_signup', 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImV2aWxAeC5jbyJ9.AAAA');
  assert.equal((await forged.req('POST', '/api/auth/email/signup', details(6))).status, 401);
});
await check('an existing candidate with the right code is signed in (no form)', async () => {
  const c = jar();
  const r = await verify(existing, await lastSentCode(jar(), existing), c);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.status, 'signed_in');
  assert.equal(r.json.data.user.email, existing); assert.equal(r.json.data.profileIncomplete, false);
  assert.equal(r.json.data.accessToken, undefined, 'tokens in the body');
  assert.equal((await c.req('GET', '/api/users/me')).status, 200);
});
await check('5 tries per code: the 6th is refused even with the right code (au13)', async () => {
  const email = addr('tries');
  const code = await devCode(jar(), email);
  for (let i = 1; i <= 4; i++) assert.equal((await verify(email, wrongOf(code))).json.attemptsLeft, 5 - i);
  const fifth = await verify(email, wrongOf(code));
  assert.equal(fifth.json.code, 'au13');
  const right = await verify(email, code);
  assert.equal(right.status, 400); assert.equal(right.json.code, 'au13');
});
await check('parallel guesses cannot exceed 5 tries', async () => {
  const email = addr('parallel');
  const code = await devCode(jar(), email);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => verify(email, String((Number(code) + 1 + i) % 1e6).padStart(6, '0'))));
  const counted = rs.filter((r) => r.json?.code === 'au12' && typeof r.json.attemptsLeft === 'number' || r.json?.code === 'au13' && r.status === 400);
  assert.equal(counted.length, 12);
  const tries = (await db.query(`SELECT attempts FROM email_codes ORDER BY id DESC LIMIT 1`)).rows[0].attempts;
  assert.equal(tries, 5, `attempts ${tries}`);
  assert.equal((await verify(email, code)).json.code, 'au13');
});
await check('a code older than 10 minutes is refused', async () => {
  const email = addr('old');
  const code = await devCode(jar(), email);
  await db.query(`UPDATE email_codes SET expires_at = now() - interval '1 second' WHERE id = (SELECT max(id) FROM email_codes)`);
  const r = await verify(email, code);
  assert.equal(r.status, 400); assert.equal(r.json.code, 'au12');
});
await check('a new code kills the older one', async () => {
  const email = addr('twice');
  const first = await devCode(jar(), email);
  const second = await devCode(jar(), email);
  if (first !== second) assert.equal((await verify(email, first)).json.code, 'au12');
  assert.equal((await verify(email, second)).json.data.status, 'signup');
});
await check('staff can never sign in by code (no code is sent; any code is refused, no session)', async () => {
  for (const email of [ADMIN_EMAIL, CM_EMAIL]) {
    const c = jar();
    const r = await verify(email, '123456', c);
    assert.equal(r.status, 400); assert.ok(['au12', 'au13'].includes(r.json.code));
    assert.ok(!c.cookies.has('access_token'));
  }
  // the dev shortcut refuses staff too
  assert.equal((await jar().req('POST', '/api/dev/email-code', { email: ADMIN_EMAIL })).status, 403);
});
await check('a deactivated account cannot sign in by code', async () => {
  const r = await candidateLogin(jar(), off);
  assert.notEqual(r.status, 200);
});
await check('a staff session is never made by code, even when a candidate becomes staff', async () => {
  const c = jar();
  assert.equal((await candidateLogin(c, existing)).status, 200);
  await db.query(`UPDATE users SET role = 'content_manager' WHERE lower(email) = $1`, [existing]);
  assert.notEqual((await c.req('GET', '/api/users')).status, 200, 'an email-code session got staff access');
  await db.query(`UPDATE users SET role = 'user' WHERE lower(email) = $1`, [existing]);
});
await check('the activity log has the code actions, with no address and no code', async () => {
  await settle();
  const rows = (await db.query(`SELECT actor, action, target, details FROM audit_log WHERE action LIKE 'auth.email_code_%' OR (action = 'auth.login' AND details->>'method' = 'email_code')`)).rows;
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['auth.email_code_requested', 'auth.email_code_limited', 'auth.email_code_refused_staff', 'auth.email_code_refused_deactivated',
    'auth.email_code_failed', 'auth.email_code_verified', 'auth.email_code_signup', 'auth.login']) assert.ok(actions.has(a), `${a} missing`);
  const text = JSON.stringify(rows);
  for (const e of [fresh, existing, off, ADMIN_EMAIL, CM_EMAIL]) assert.ok(!text.includes(e), `${e} in the log`);
  assert.ok(!/"\d{6}"|:\d{6}[,}]/.test(JSON.stringify(rows.map((r) => r.details))), 'a code in the log details');
  const viaScreen = await staffJar.req('GET', '/api/admin/audit?action=auth.email_code_');
  assert.equal(viaScreen.status, 200, viaScreen.text);
});
await check('the dev endpoints exist only in development (this server: DEV_MODE)', async () => {
  // Shown here so a run against a non-dev server fails loudly instead of skipping.
  assert.equal((await jar().req('GET', `/api/dev/email-code?email=${encodeURIComponent(addr('none'))}`)).status, 404);
});

await db.end();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
