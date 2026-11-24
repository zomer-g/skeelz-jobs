// Sign-in end to end, against a running LOCAL server configured for the mock provider (see helpers/staffLogin.mjs),
// plus a second server this script starts itself with no providers configured.
//   BASE=http://localhost:3100 node test/e2e-auth.mjs
// Covers: candidate sign-up / sign-in by a code sent by email; the password routes gone; staff get no code; "Continue with Google" = xhostd
// SSO for staff (existing staff only, never created/promoted) and for candidates (new identity -> the sign-up form,
// created only when it is sent, email from the SSO identity; existing candidate -> linked; an account without a phone
// -> asked to complete it); the personal area (own record only, allowlisted fields, staff refused); token refusals;
// the button hidden when SSO is off; the cross-site exception for the callback only. Never point this at production.
// Uses DATABASE_URL (from server/.env) for one setup row and to confirm what was (not) created.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { mockIdp, xhostdSignIn, signedInOk, signInError, subFor } from './helpers/staffLogin.mjs';
import { signUp, candidateLogin } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();
const UNCONFIGURED_PORT = Number(process.env.UNCONFIGURED_PORT || 3104);

const rawRequest = (url, method, headers, body) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      const h = res.headers;
      resolve({ status: res.statusCode, text, setCookies: [].concat(h['set-cookie'] ?? []),
        headers: { get: (k) => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } } });
    });
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

const jar = (base = BASE) => {
  const cookies = new Map();
  return {
    cookies,
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, p, body, extraHeaders = {}) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders };
      if (body) headers['Content-Type'] = 'application/json';
      // node:http, not fetch: fetch overrides Sec-Fetch-* headers, and these checks need a real "navigate".
      const res = await rawRequest(base + p, method, headers, body ? JSON.stringify(body) : undefined);
      for (const c of res.setCookies) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (v && !/expires=Thu, 01 Jan 1970/i.test(c)) cookies.set(k, v); else cookies.delete(k);
      }
      const text = res.text;
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

const idp = await mockIdp();
const stamp = Date.now();
const loc = (r) => r.headers.get('location') || '';

// ---------------------------------------------------------------------------
// Providers off: a second server with none configured.
const here = path.dirname(fileURLToPath(import.meta.url));
const unconfigured = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.resolve(here, '..'),
  env: { ...process.env, PORT: String(UNCONFIGURED_PORT), XHOST_HTTP_PORT: String(UNCONFIGURED_PORT),
    SSO_ENABLED: 'false', ENABLE_MICROSOFT_SSO: 'false', EMAIL_CODE_SIGNIN_ENABLED: 'false', DB_POOL_MAX: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const offBase = `http://localhost:${UNCONFIGURED_PORT}`;
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('unconfigured server did not start')), 60_000);
  unconfigured.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); resolve(); } });
  unconfigured.on('exit', (c) => reject(new Error(`unconfigured server exited ${c}`)));
});
try {
  await check('SSO off: providers report it off (the Google button is hidden)', async () => {
    const r = await jar(offBase).req('GET', '/api/auth/providers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { password: false, emailCode: false, sso: false, ssoLogoutUrl: null, microsoft: false });
  });
  await check('SSO off: start refuses with signin_error=disabled (no redirect to xhostd)', async () => {
    const r = await jar(offBase).req('GET', '/api/auth/xhostd/start?return_to=/');
    assert.equal(r.status, 302);
    assert.equal(loc(r), '/?signin_error=disabled');
  });
  await check('email code off (EMAIL_CODE_SIGNIN_ENABLED not true): every route answers 503 au18 and nothing is stored', async () => {
    const email = `off-${stamp}@example.test`;
    for (const [m, p, b] of [['POST', '/api/auth/email/request', { email }], ['POST', '/api/auth/email/verify', { email, code: '123456' }],
      ['POST', '/api/auth/email/signup', { email }], ['POST', '/api/dev/email-code', { email }]]) {
      const r = await jar(offBase).req(m, p, b);
      assert.equal(r.status, 503, `${p}: ${r.status} ${r.text}`); assert.equal(r.json.code, 'au18', p);
    }
    assert.equal((await jar(offBase).req('GET', '/api/auth/email/signup')).json.data, null);
  });
  await check('the old direct-Google routes are gone', async () => {
    assert.equal((await jar(offBase).req('GET', '/api/auth/google/start')).status, 404);
  });
} finally {
  unconfigured.kill();
}

// ---------------------------------------------------------------------------
await check('SSO on: providers report it (the Google button shows) with the xhostd logout URL', async () => {
  const r = await jar().req('GET', '/api/auth/providers');
  assert.equal(r.json.data.sso, true, 'start the local server with SSO_ENABLED=true and the mock issuer');
  assert.ok(r.json.data.ssoLogoutUrl);
});

// --- candidates: a code by email (no passwords) ---------------------------------
const candEmail = `auth-cand-${stamp}@example.test`;
let candId;
await check('candidate signs up and signs in with a code by email', async () => {
  const c = jar();
  const r = await signUp(c, {
    firstName: 'Auth', lastName: 'Cand', email: candEmail, phoneNumber: `05${String(stamp).slice(-8)}`,
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  candId = r.json.data._id ?? r.json.data.user?._id;
  const c2 = jar();
  const l = await candidateLogin(c2, candEmail);
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.data.user.role, 'user');
  assert.equal(l.json.data.user.password, undefined);
  const s = await c2.req('GET', '/api/auth/session');
  assert.equal(s.json.data.user.email, candEmail);
});

// --- passwords are gone; staff get no code --------------------------------------
await check('the password routes are gone (sign-in, sign-up, reset)', async () => {
  for (const [m, p, b] of [['POST', '/api/login', { email: candEmail, password: 'secret-pass-1' }], ['POST', '/api/users', { email: `x-${stamp}@example.test`, password: 'x' }],
    ['POST', '/api/password/reset/initiate', { email: candEmail }], ['POST', '/api/password/reset', { token: 'x', newPassword: 'Abcdefg1' }]]) {
    const r = await jar().req(m, p, b);
    assert.equal(r.status, 404, `${p}: ${r.status}`);
  }
});
await check('staff: the code request answers like any address, and no code is sent or usable', async () => {
  const a = await jar().req('POST', '/api/auth/email/request', { email: ADMIN_EMAIL });
  const b = await jar().req('POST', '/api/auth/email/request', { email: `nobody-staff-${stamp}@example.test` });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.text, b.text);
  assert.equal((await jar().req('GET', `/api/dev/email-code?email=${encodeURIComponent(ADMIN_EMAIL)}`)).status, 404, 'a code was sent to staff');
  const c = jar();
  const v = await c.req('POST', '/api/auth/email/verify', { email: ADMIN_EMAIL, code: '000000' });
  assert.equal(v.status, 400); assert.equal(v.json.code, 'au12');
  assert.ok(!c.cookies.has('access_token') && !c.cookies.has('refresh_token'), 'tokens were set');
});

// --- staff: xhostd SSO --------------------------------------------------------
const admin = jar();
await check('staff sign in with xhostd SSO and reach the admin screens', async () => {
  const r = await xhostdSignIn(admin, ADMIN_EMAIL, { returnTo: '/security-management' });
  assert.ok(signedInOk(r), `callback went to ${loc(r)}`);
  assert.ok(loc(r).startsWith('/security-management?'), loc(r));
  assert.equal((await admin.req('GET', '/api/admin/security')).status, 200);
  const s = await admin.req('GET', '/api/auth/session');
  assert.equal(s.json.data.user.role, 'admin');
});
await check('the activity log has the SSO login and the refusals', async () => {
  const r = await admin.req('GET', `/api/admin/audit?q=${encodeURIComponent(ADMIN_EMAIL)}`);
  assert.equal(r.status, 200, r.text);
  const rows = r.json.data?.entries ?? r.json.data?.rows ?? r.json.data ?? [];
  const actions = new Set((Array.isArray(rows) ? rows : []).map((e) => e.action));
  for (const a of ['auth.login', 'auth.email_code_refused_staff']) {
    if (!actions.has(a)) {
      // fall back to a broader search if the screen filters by actor only
      const all = await admin.req('GET', `/api/admin/audit?action=${a}`);
      assert.ok(all.text.includes(a), `${a} not in the log`);
    }
  }
});
await check('xhostd SSO: a second sign-in finds the account by the stored subject, even with another email', async () => {
  const r = await xhostdSignIn(jar(), 'changed-address@example.test', { sub: subFor(ADMIN_EMAIL) });
  assert.ok(signedInOk(r), loc(r));
});
await check('content manager signs in with SSO and reaches candidates', async () => {
  const c = jar();
  assert.ok(signedInOk(await xhostdSignIn(c, CM_EMAIL)));
  assert.equal((await c.req('GET', '/api/users')).status, 200);
  assert.equal((await c.req('GET', '/api/auth/session')).json.data.user.role, 'content_manager');
});
await check('xhostd SSO refuses a cookie for another host, an expired one, a forged one, and a missing state', async () => {
  assert.equal(signInError(await xhostdSignIn(jar(), ADMIN_EMAIL, { host: 'evil.example.test' })), 'failed');
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(signInError(await xhostdSignIn(jar(), ADMIN_EMAIL, { claims: { iat: past - 60, exp: past } })), 'failed');
  assert.equal(signInError(await xhostdSignIn(jar(), ADMIN_EMAIL, { claims: { iss: 'https://evil' } })), 'failed');
  // No state cookie (an attacker's link): refused before the identity cookie is even read.
  const c = jar();
  c.setCookie('__Host-xhost_id', idp.sign({ aud: 'localhost', sub: subFor(ADMIN_EMAIL), email: ADMIN_EMAIL }));
  const r = await c.req('GET', '/api/auth/xhostd/callback?state=guess');
  assert.equal(signInError(r), 'state');
  assert.ok(!c.cookies.has('access_token'));
});

// --- candidates: "Continue with Google" (xhostd SSO) -----------------------------------------
const gEmail = `auth-google-${stamp}@example.test`;
let gId;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const countByEmail = async (email) => Number((await db.query('SELECT count(*) AS n FROM users WHERE lower(email) = lower($1)', [email])).rows[0].n);
const signupOf = (r) => new URL(loc(r), 'http://p').searchParams.get('signin') === 'signup';
const phoneFor = (n) => `05${String(stamp + n).slice(-8)}`;
const details = (n, extra = {}) => ({
  firstName: 'גיל', lastName: 'גוגל', phoneNumber: phoneFor(n), citySymbol: 9000, gender: 'male',
  dateOfBirth: '1992-03-04T00:00:00.000Z', skills: [], consent: true, ...extra,
});
await check('SSO: a new identity gets the sign-up form (prefilled from Google); nothing is created yet', async () => {
  const c = jar();
  const r = await xhostdSignIn(c, gEmail, { sub: `g-${stamp}`, claims: { name: 'Gil Google' }, returnTo: '/post-job' });
  assert.ok(signupOf(r), loc(r));
  assert.ok(loc(r).startsWith('/post-job?'));
  assert.ok(c.cookies.has('sso_signup'), 'no pending sign-up cookie');
  assert.equal((await c.req('GET', '/api/auth/session')).json.data, null, 'signed in before the form was sent');
  const p = await c.req('GET', '/api/auth/xhostd/signup');
  assert.deepEqual(p.json.data, { email: gEmail, firstName: 'Gil', lastName: 'Google' });
  assert.equal(await countByEmail(gEmail), 0, 'an account was created before the form');
});
await check('SSO sign-up abandoned: nothing is created; without (or with a forged) cookie the form is refused', async () => {
  const email = `abandon-${gEmail}`;
  assert.ok(signupOf(await xhostdSignIn(jar(), email, { sub: `g-abandon-${stamp}` })));
  // walks away; later the same identity again: still the form (no account appeared)
  assert.ok(signupOf(await xhostdSignIn(jar(), email, { sub: `g-abandon-${stamp}` })));
  assert.equal(await countByEmail(email), 0);
  const none = await jar().req('POST', '/api/auth/xhostd/signup', details(90));
  assert.equal(none.status, 401); assert.equal(none.json.code, 'au11');
  const forged = jar();
  forged.setCookie('sso_signup', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZW1haWwiOiJ4QHguY28ifQ.AAAA');
  assert.equal((await forged.req('POST', '/api/auth/xhostd/signup', details(91))).status, 401);
});
await check('SSO sign-up: the same required details as sign-up; the form cannot choose the email, role or password', async () => {
  const c = jar();
  assert.ok(signupOf(await xhostdSignIn(c, gEmail, { sub: `g-${stamp}`, claims: { name: 'Gil Google' } })));
  const missing = await c.req('POST', '/api/auth/xhostd/signup', { firstName: 'גיל', lastName: 'גוגל' });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json.fields.sort(), ['citySymbol', 'dateOfBirth', 'gender', 'phoneNumber']);
  const badPhone = await c.req('POST', '/api/auth/xhostd/signup', details(1, { phoneNumber: '123' }));
  assert.deepEqual(badPhone.json.fields, ['phoneNumber']);
  const evil = `evil-${stamp}@example.test`;
  const r = await c.req('POST', '/api/auth/xhostd/signup', details(1, { email: evil, role: 'admin', password: 'x' }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.email, gEmail);
  assert.equal(r.json.data.user.role, 'user');
  assert.equal(r.json.data.user.password, undefined);
  assert.equal(await countByEmail(evil), 0);
  const row = (await db.query('SELECT password, xhostd_sub, phone_number FROM users WHERE lower(email) = $1', [gEmail])).rows[0];
  assert.equal(row.password, ''); assert.equal(row.xhostd_sub, `g-${stamp}`); assert.equal(row.phone_number, phoneFor(1));
  const s2 = await c.req('GET', '/api/auth/session');
  assert.equal(s2.json.data.user.email, gEmail, 'not signed in after the form');
  assert.equal(s2.json.data.profileIncomplete, false);
  gId = String(s2.json.data.user._id);
  for (const p of ['/api/admin/security', '/api/users']) assert.notEqual((await c.req('GET', p)).status, 200, p);
  // the pending cookie is spent
  assert.equal((await c.req('POST', '/api/auth/xhostd/signup', details(2))).status, 401);
  // and the next Google sign-in goes straight in
  const again = jar();
  assert.ok(signedInOk(await xhostdSignIn(again, gEmail, { sub: `g-${stamp}` })));
  assert.equal(String((await again.req('GET', '/api/auth/session')).json.data.user._id), gId);
});
await check('SSO: an account an earlier SSO sign-in created without a phone is asked to complete its details', async () => {
  const email = `bare-${stamp}@example.test`; const sub = `g-bare-${stamp}`;
  await db.query(`INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, role, xhostd_sub)
                  VALUES ($1, 'Bare', '-', $2, NULL, '', -1, '', 'user', $3)`, [crypto.randomBytes(12).toString('hex'), email, sub]);
  const c = jar();
  assert.ok(signedInOk(await xhostdSignIn(c, email, { sub })));
  assert.equal((await c.req('GET', '/api/auth/session')).json.data.profileIncomplete, true);
  const me = await c.req('GET', '/api/users/me');
  assert.equal(me.json.data.profileIncomplete, true);
  assert.equal(me.json.data.ssoLinked, true); assert.equal('hasPassword' in me.json.data, false);
  const done = await c.req('PATCH', '/api/users/me', details(3, { firstName: 'Bara', lastName: 'Complete' }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.data.profileIncomplete, false);
  assert.equal((await c.req('GET', '/api/auth/session')).json.data.profileIncomplete, false);
});
await check('SSO: the same identity signs into the same account again (by subject, even with a changed email)', async () => {
  const c = jar();
  assert.ok(signedInOk(await xhostdSignIn(c, `changed-${gEmail}`, { sub: `g-${stamp}` })));
  assert.equal(String((await c.req('GET', '/api/auth/session')).json.data.user._id), gId);
});
await check('SSO: the email of an existing candidate links to it; a leftover password is cleared, old sessions end, notice shown', async () => {
  const old = jar();
  assert.equal((await candidateLogin(old, candEmail)).status, 200);
  // A hash left from before 11.2026 (the migration clears them; this proves the SSO link clears one too).
  await db.query(`UPDATE users SET password = '$2a$10$legacylegacylegacylegacyleg' WHERE id = $1`, [String(candId)]);
  const c = jar();
  const r = await xhostdSignIn(c, candEmail.toUpperCase(), { sub: `g-link-${stamp}` });
  assert.ok(signedInOk(r));
  assert.match(loc(r), /[?&]notice=password_cleared\b/, 'no on-screen notice');
  assert.equal(String((await c.req('GET', '/api/auth/session')).json.data.user._id), String(candId));
  assert.equal((await db.query('SELECT password FROM users WHERE id = $1', [String(candId)])).rows[0].password, '');
  assert.notEqual((await old.req('GET', '/api/users/me')).status, 200, 'the earlier session still works');
  assert.equal((await c.req('GET', '/api/users/me')).status, 200, 'the new Google session does not work');
  const logged = await db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.sso_password_cleared' AND actor = $1`, [`user:${candId}`]);
  assert.equal(logged.rowCount, 1);
  // ... and the code by email still signs the same account in.
  const byCode = jar();
  assert.equal(String((await candidateLogin(byCode, candEmail)).json.data.user._id), String(candId));
});
await check('SSO: an account already linked to another Google identity is not taken over', async () => {
  const r = await xhostdSignIn(jar(), candEmail, { sub: `g-other-${stamp}` });
  assert.equal(signInError(r), 'link_conflict');
});
// Several roles per account (owner, 23.11.2026): the staff role is ADDED; the candidate role and data stay.
await check('staff screen: a candidate\'s account gets the staff role added and stays a candidate; removing it keeps the candidate', async () => {
  const add = await admin.req('POST', '/api/admin/staff', { email: candEmail, role: 'content_manager' });
  assert.equal(add.status, 200, add.text);
  let row = (await db.query(`SELECT role, roles FROM users WHERE id = $1`, [String(candId)])).rows[0];
  assert.deepEqual([...row.roles].sort(), ['content_manager', 'user']);
  assert.equal(row.role, 'content_manager', 'role = the highest of roles');
  assert.equal((await admin.req('PATCH', `/api/admin/staff/${candId}/role`, { role: 'user' })).status, 200);
  row = (await db.query(`SELECT role, roles FROM users WHERE id = $1`, [String(candId)])).rows[0];
  assert.deepEqual(row.roles, ['user']);
  assert.equal(row.role, 'user');
});
await check('code requests: the same answer for every address; no typed email in the log', async () => {
  const typed = `nobody-typed-${stamp}@example.test`;
  const answers = [];
  // A new address, a candidate (no code asked for it yet), staff (the content manager: the admin asked a minute ago).
  for (const email of [typed, gEmail, CM_EMAIL]) {
    const r = await jar().req('POST', '/api/auth/email/request', { email });
    answers.push(`${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(new Set(answers).size, 1, answers.join(' | '));
  await jar().req('POST', '/api/auth/email/verify', { email: typed, code: '123456' });
  await new Promise((res) => setTimeout(res, 300)); // the log writes are fire-and-forget
  const rows = await db.query(
    `SELECT action, target, details FROM audit_log WHERE action LIKE 'auth.email_code_%' AND at > now() - interval '2 minutes'`);
  assert.ok(rows.rowCount >= 4, `only ${rows.rowCount} entries`);
  const text = JSON.stringify(rows.rows);
  assert.ok(!text.includes(typed) && !text.includes(gEmail.toLowerCase()) && !text.includes(ADMIN_EMAIL) && !text.includes(CM_EMAIL), 'a typed email is in the log');
  assert.ok(rows.rows.some((r) => r.target === `user:${gId}`), 'a known account is logged as user:<id>');
  assert.ok(rows.rows.some((r) => /^email#[0-9a-f]{12}$/.test(r.target ?? '')), 'an unknown address is logged as a hash');
  assert.ok(!/\b\d{6}\b/.test(JSON.stringify(rows.rows.map((r) => r.details))), 'a code-like number is in the log details');
});
await check('SSO: a missing identity cookie is refused (no_sso_session)', async () => {
  const c = jar();
  const start = await c.req('GET', '/api/auth/xhostd/start');
  const back = new URL(loc(start), 'http://p').searchParams.get('return_to');
  assert.equal(signInError(await c.req('GET', back)), 'no_sso_session');
});

// --- the personal area: a candidate's own details -------------------------------------------
await check('personal area: a candidate edits their own details and profile CV; logged with field names only', async () => {
  const c = jar();
  assert.ok(signedInOk(await xhostdSignIn(c, gEmail, { sub: `g-${stamp}` })));
  const r = await c.req('PATCH', '/api/users/me', { firstName: 'גילי', citySymbol: 3000, phoneNumber: phoneFor(4) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.firstName, 'גילי'); assert.equal(r.json.data.user.citySymbol, 3000);
  // a new profile CV: an unclaimed upload becomes this user's; then it is removed
  const doc = await PDFDocument.create(); doc.addPage().drawText('CV');
  const token = crypto.randomUUID(); const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await doc.save())], { type: 'application/pdf' }), 'cv.pdf');
  assert.equal((await fetch(`${BASE}/api/files/${token}`, { method: 'POST', body: fd })).status, 200);
  const cv = await c.req('PATCH', '/api/users/me', { cvFileUrl: `${token}/cv.pdf` });
  assert.equal(cv.json.data.user.cvFileUrl, `post-scan/${token}/cv.pdf`);
  assert.ok((await c.req('GET', '/api/users/me/cv')).json.data.cv);
  const del = await c.req('DELETE', '/api/users/me/cv');
  assert.equal(del.status, 200); assert.equal(del.json.data.user.cvFileUrl, '');
  const log = await admin.req('GET', `/api/admin/audit?action=user.profile_updated&actor=${encodeURIComponent(`user:${gId}`)}`);
  assert.equal(log.status, 200, log.text);
  const text = JSON.stringify(log.json);
  assert.ok(text.includes('citySymbol') && text.includes('phoneNumber'), 'no profile_updated entry');
  assert.ok(!text.includes('גילי') && !text.includes(phoneFor(4)), 'values in the log');
});
await check('personal area: no way to edit another record, the email, the role or the password', async () => {
  const c = jar();
  assert.ok(signedInOk(await xhostdSignIn(c, gEmail, { sub: `g-${stamp}` })));
  // the content managers' edit route: refused (the gate also signs that session out, so a separate one)
  const probe = jar();
  assert.ok(signedInOk(await xhostdSignIn(probe, gEmail, { sub: `g-${stamp}` })));
  assert.notEqual((await probe.req('PATCH', `/api/users/${candId}`, { firstName: 'Hacked' })).status, 200);
  assert.notEqual((await db.query('SELECT first_name FROM users WHERE id = $1', [candId])).rows[0].first_name, 'Hacked');
  const r = await c.req('PATCH', '/api/users/me', { _id: candId, id: candId, userId: candId, email: `x-${stamp}@example.test`,
    role: 'admin', password: 'NewPass123', xhostd_sub: 'other', lastName: 'Own' });
  assert.equal(r.status, 200, r.text);
  assert.equal(String(r.json.data.user._id), gId);
  assert.equal(r.json.data.user.email, gEmail); assert.equal(r.json.data.user.role, 'user');
  const other = (await db.query('SELECT last_name, email FROM users WHERE id = $1', [candId])).rows[0];
  assert.notEqual(other.last_name, 'Own'); assert.equal(other.email, candEmail);
  const mine = (await db.query('SELECT password, xhostd_sub FROM users WHERE id = $1', [gId])).rows[0];
  assert.equal(mine.password, ''); assert.equal(mine.xhostd_sub, `g-${stamp}`);
  const bad = await c.req('PATCH', '/api/users/me', { phoneNumber: '12', gender: 'x' });
  assert.equal(bad.status, 400); assert.deepEqual(bad.json.fields.sort(), ['gender', 'phoneNumber']);
  const taken = await c.req('PATCH', '/api/users/me', { phoneNumber: phoneFor(3) }); // the "bare" account's phone
  assert.equal(taken.status, 400); assert.equal(taken.json.code, 'us3');
  // not signed in: the gate refuses (code au2; the site answers gate refusals with 400)
  for (const [m, b] of [['GET'], ['PATCH', { firstName: 'Anon' }], ['DELETE']]) {
    const r2 = await jar().req(m, m === 'DELETE' ? '/api/users/me/cv' : '/api/users/me', b);
    assert.notEqual(r2.status, 200, `${m} anonymous`); assert.equal(r2.json?.code, 'au2', `${m} anonymous`);
  }
});
await check('personal area: staff are refused (staff accounts are managed by admins)', async () => {
  assert.equal((await admin.req('GET', '/api/users/me')).status, 403);
  assert.equal((await admin.req('PATCH', '/api/users/me', { firstName: 'Admin' })).status, 403);
});

// --- the cross-site exception covers only the callbacks ----------------------------------
await check('cross-site: the callback passes as a top-level navigation; the rest of /api is still refused', async () => {
  const cb = await jar().req('GET', '/api/auth/xhostd/callback?state=x', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(cb.status, 302);
  const cbFetch = await jar().req('GET', '/api/auth/xhostd/callback?state=x', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' });
  assert.equal(cbFetch.status, 403);
  for (const p of ['/api/auth/email/request', '/api/auth/email/verify']) {
    const r = await jar().req('POST', p, { email: candEmail, code: '123456' }, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
    assert.equal(r.status, 403, p);
  }
  const start = await jar().req('GET', '/api/auth/xhostd/start', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(start.status, 403, 'another site may not start a sign-in in the visitor\'s browser');
});
await check('return_to cannot leave the site', async () => {
  const r = await jar().req('GET', '/api/auth/xhostd/start?return_to=//evil.example.test/x');
  const flowState = new URL(loc(r), 'http://p').searchParams.get('return_to');
  assert.ok(flowState.startsWith('/api/auth/xhostd/callback?state='));
  const c = jar();
  const done = await xhostdSignIn(c, ADMIN_EMAIL, { returnTo: 'https://evil.example.test' });
  assert.ok(loc(done).startsWith('/?signin=ok'), loc(done));
});

await idp.close();
await db.end();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
