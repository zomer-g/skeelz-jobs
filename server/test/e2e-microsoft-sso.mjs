// "Continue with Microsoft" end to end, against a running LOCAL server that trusts the mock provider (DEV_MODE only):
//   ENABLE_MICROSOFT_SSO=true MS_CLIENT_ID=e2e-ms-client MS_CLIENT_SECRET=e2e-ms-secret MS_LOGIN_BASE=http://127.0.0.1:3199
//   (plus the xhostd mock values from helpers/staffLogin.mjs; both use the same mock on port 3199)
//   BASE=http://localhost:3100 node test/e2e-microsoft-sso.mjs
// The test plays the browser and Microsoft: it follows /start to the mock's authorize URL, tells the mock which ID
// token to answer the code with, and comes back to /callback. Covers: the authorize request (PKCE S256, nonce, state,
// scopes, redirect URI); the code exchange (secret, verifier, redirect URI); new identity → the shared sign-up form →
// a candidate linked to ms_sub; the same identity again; an existing candidate linked by verified email (password
// cleared); work accounts without xms_edov, preferred_username-only tokens, staff emails, wrong nonce / audience /
// tenant, a replayed code, a bad state and a cancel are all refused with nothing created; the cross-site exception;
// the button and routes off when not enabled. Never point this at production.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { mockIdp } from './helpers/staffLogin.mjs';
import { signUp } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const CLIENT_ID = process.env.MS_CLIENT_ID || 'e2e-ms-client';
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 'e2e-ms-secret';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || process.env.CONTENT_MANAGER_EMAIL || 'content@example.test').toLowerCase();
const OFF_PORT = Number(process.env.MS_OFF_PORT || 3105);
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad';
const WORK = '0f0e0d0c-0b0a-4900-8000-123456789abc';

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
    async req(method, p, body, extraHeaders = {}) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await rawRequest(base + p, method, headers, body ? JSON.stringify(body) : undefined);
      for (const c of res.setCookies) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (v && !/expires=Thu, 01 Jan 1970/i.test(c)) cookies.set(k, v); else cookies.delete(k);
      }
      let json; try { json = JSON.parse(res.text); } catch { json = null; }
      return { status: res.status, json, text: res.text, headers: res.headers };
    },
  };
};

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const loc = (r) => r.headers.get('location') || '';
const param = (r, k) => new URL(loc(r), 'http://p').searchParams.get(k);
const idp = await mockIdp();
const stamp = Date.now();
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

/** Follows /start; returns the authorize URL's parameters. */
const start = async (c, returnTo = '/') => {
  const r = await c.req('GET', `/api/auth/microsoft/start?return_to=${encodeURIComponent(returnTo)}`);
  if (r.status !== 302) throw new Error(`start answered ${r.status}`);
  const u = new URL(loc(r));
  return { url: u, p: u.searchParams };
};
/** A whole Microsoft sign-in. `claims` go into the ID token (nonce/iss/aud/tid filled in unless given). */
const msSignIn = async (c, claims, { tid = PERSONAL, returnTo = '/', tamper = (q) => q } = {}) => {
  const { p } = await start(c, returnTo);
  const code = `code-${crypto.randomBytes(8).toString('hex')}`;
  idp.registerCode(code, { iss: `${idp.issuer}/${tid}/v2.0`, aud: CLIENT_ID, tid, nonce: p.get('nonce'), ...claims },
    { challenge: p.get('code_challenge'), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const q = tamper(new URLSearchParams({ code, state: p.get('state') }));
  return c.req('GET', `/api/auth/microsoft/callback?${q.toString()}`);
};
const okSignIn = (r) => r.status === 302 && param(r, 'signin') === 'ok';
const signup = (r) => r.status === 302 && param(r, 'signin') === 'signup';
const usersWithEmail = async (email) => Number((await one('SELECT count(*) AS n FROM users WHERE lower(email) = lower($1)', [email])).n);
const phone = (n) => `05${String(stamp + n).slice(-8)}`;
const details = (n, extra = {}) => ({
  firstName: 'מיה', lastName: 'מייקרוסופט', phoneNumber: phone(n), citySymbol: 9000, gender: 'female',
  dateOfBirth: '1991-05-06T00:00:00.000Z', skills: [], consent: true, ...extra,
});

// ---------------------------------------------------------------------------
// Not enabled: a second server with Microsoft off.
const here = path.dirname(fileURLToPath(import.meta.url));
const off = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.resolve(here, '..'),
  env: { ...process.env, PORT: String(OFF_PORT), XHOST_HTTP_PORT: String(OFF_PORT), ENABLE_MICROSOFT_SSO: 'false', DB_POOL_MAX: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('the Microsoft-off server did not start')), 60_000);
  let errText = '';
  off.stderr.on('data', (d) => { errText = (errText + String(d)).slice(-2000); });
  off.stdout.on('data', (d) => { errText = (errText + String(d)).slice(-2000); if (/listening on/.test(String(d))) { clearTimeout(t); resolve(); } });
  off.on('exit', (c) => reject(new Error(`the Microsoft-off server exited ${c}: ${errText}`)));
});
try {
  const offBase = `http://localhost:${OFF_PORT}`;
  await check('off: providers say microsoft=false (no button); start and callback answer signin_error=disabled', async () => {
    assert.equal((await jar(offBase).req('GET', '/api/auth/providers')).json.data.microsoft, false);
    const s = await jar(offBase).req('GET', '/api/auth/microsoft/start?return_to=/');
    assert.equal(s.status, 302); assert.equal(loc(s), '/?signin_error=disabled');
    const cb = await jar(offBase).req('GET', '/api/auth/microsoft/callback?code=x&state=y');
    assert.equal(loc(cb), '/?signin_error=disabled');
  });
} finally {
  off.kill();
}

// ---------------------------------------------------------------------------
await check('on: providers say microsoft=true (the button shows)', async () => {
  const r = await jar().req('GET', '/api/auth/providers');
  assert.equal(r.json.data.microsoft, true, 'start the local server with ENABLE_MICROSOFT_SSO=true, MS_CLIENT_ID/SECRET and MS_LOGIN_BASE (see the top of this file)');
});

await check('start: authorize request with code + PKCE S256, nonce, state, openid email profile, our redirect URI; httpOnly flow cookie', async () => {
  const c = jar();
  const r = await c.req('GET', '/api/auth/microsoft/start?return_to=/job/1');
  const u = new URL(loc(r));
  assert.equal(`${u.origin}${u.pathname}`, `${idp.issuer}/common/oauth2/v2.0/authorize`);
  const p = u.searchParams;
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid email profile');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.match(p.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(p.get('state')?.length >= 32 && p.get('nonce')?.length >= 32);
  assert.equal(p.get('redirect_uri'), `${BASE.replace('127.0.0.1', 'localhost')}/api/auth/microsoft/callback`);
  assert.ok(!p.has('client_secret'));
  const set = r.headers.get('set-cookie') || '';
  assert.match(set, /oidc_microsoft=[^;]+;.*HttpOnly/i);
  assert.match(set, /Path=\/api\/auth/i);
  assert.match(set, /SameSite=Lax/i);
});

// --- a new personal account → the sign-up form → candidate ------------------------------
const newEmail = `ms-new-${stamp}@outlook.example`;
const newSub = `ms-sub-${stamp}`;
let newId;
await check('new identity: the sign-up form, prefilled; nothing created yet; code exchanged with secret + verifier', async () => {
  const before = idp.seen.tokenRequests.length;
  const c = jar();
  const r = await msSignIn(c, { sub: newSub, email: newEmail.toUpperCase(), name: 'Maya Microsoft' });
  assert.ok(signup(r), loc(r));
  assert.ok(!c.cookies.has('access_token'));
  assert.equal(await usersWithEmail(newEmail), 0);
  const p = await c.req('GET', '/api/auth/xhostd/signup');
  assert.deepEqual(p.json.data, { email: newEmail, firstName: 'Maya', lastName: 'Microsoft' });
  const tr = idp.seen.tokenRequests.slice(before).at(-1);
  assert.equal(tr.grant_type, 'authorization_code');
  assert.equal(tr.client_id, CLIENT_ID); assert.equal(tr.client_secret, CLIENT_SECRET);
  assert.ok(tr.code_verifier?.length >= 43);
  assert.equal(tr.redirect_uri, `${BASE.replace('127.0.0.1', 'localhost')}/api/auth/microsoft/callback`);

  const done = await c.req('POST', '/api/auth/xhostd/signup', details(1, { email: 'evil@example.test', role: 'admin' }));
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.data.user.email, newEmail, 'the email must come from the Microsoft identity');
  assert.equal(done.json.data.user.role, 'user');
  newId = String(done.json.data.user._id);
  const row = await one('SELECT ms_sub, xhostd_sub, password FROM users WHERE id = $1', [newId]);
  assert.equal(row.ms_sub, `${PERSONAL}:${newSub}`);
  assert.equal(row.xhostd_sub, null);
  assert.equal(row.password, '');
  assert.equal((await c.req('GET', '/api/users/me')).status, 200);
  const a = await one(`SELECT details FROM audit_log WHERE action = 'auth.signup_sso' AND target = $1`, [newId]);
  assert.equal(a.details.provider, 'microsoft');
});
await check('the same identity again signs in directly (by ms_sub), audit method=microsoft', async () => {
  const c = jar();
  const r = await msSignIn(c, { sub: newSub, email: newEmail });
  assert.ok(okSignIn(r), loc(r));
  const s = await c.req('GET', '/api/auth/session');
  assert.equal(String(s.json.data.user._id), newId);
  const a = await one(`SELECT details FROM audit_log WHERE action = 'auth.login' AND actor = $1 ORDER BY at DESC LIMIT 1`, [`user:${newId}`]);
  assert.equal(a.details.method, 'microsoft');
});

// --- an existing candidate (a password left from before 11.2026), work account with a verified email domain -----------
const candEmail = `ms-cand-${stamp}@corp.example`;
let candId;
await check('existing candidate + work account with xms_edov=true: linked by email, password cleared, notice', async () => {
  const reg = await signUp(jar(), {
    firstName: 'Cand', lastName: 'Work', email: candEmail, phoneNumber: phone(2), dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'other', citySymbol: 9000, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(reg.status, 200, reg.text);
  candId = String(reg.json.data._id ?? reg.json.data.user?._id);
  // A hash left from before 11.2026 (the migration clears them; the Microsoft link clears one too).
  await db.query(`UPDATE users SET password = '$2a$10$legacylegacylegacylegacyleg' WHERE id = $1`, [candId]);
  const c = jar();
  const r = await msSignIn(c, { sub: `w-${stamp}`, email: candEmail, xms_edov: true }, { tid: WORK });
  assert.ok(okSignIn(r), loc(r));
  assert.equal(param(r, 'notice'), 'password_cleared_ms');
  assert.equal(String((await c.req('GET', '/api/auth/session')).json.data.user._id), candId);
  const row = await one('SELECT ms_sub, password FROM users WHERE id = $1', [candId]);
  assert.equal(row.ms_sub, `${WORK}:w-${stamp}`);
  assert.equal(row.password, '');
});
await check('another Microsoft identity with the same email cannot take over a linked account', async () => {
  const r = await msSignIn(jar(), { sub: `w2-${stamp}`, email: candEmail, xms_edov: true }, { tid: WORK });
  assert.equal(param(r, 'signin_error'), 'link_conflict');
});

// --- refusals: nothing created, no session ----------------------------------------------
const refused = async (name, run, code) => check(name, async () => {
  const c = jar();
  const r = await run(c);
  assert.equal(param(r, 'signin_error'), code, loc(r));
  assert.ok(!c.cookies.has('access_token') && !c.cookies.has('sso_signup'), 'a session or sign-up cookie was set');
});
const unverified = `ms-unverified-${stamp}@corp.example`;
await refused('work account WITHOUT xms_edov: refused (unverified email)',
  (c) => msSignIn(c, { sub: `u-${stamp}`, email: unverified }, { tid: WORK }), 'ms_unverified_email');
await check('… and nothing was created for it', async () => assert.equal(await usersWithEmail(unverified), 0));
await refused('preferred_username / upn only (no email claim): refused',
  (c) => msSignIn(c, { sub: `pu-${stamp}`, preferred_username: candEmail, upn: candEmail }, { tid: WORK }), 'failed');
await refused('admin email: refused (staff sign in only with Google)', (c) => msSignIn(c, { sub: `adm-${stamp}`, email: ADMIN_EMAIL }), 'staff_google_only');
await refused('content manager email (verified work account): refused', (c) => msSignIn(c, { sub: `cm-${stamp}`, email: CM_EMAIL, xms_edov: true }, { tid: WORK }), 'staff_google_only');
await check('… and no Microsoft identity was linked to a staff account', async () => {
  const r = await one(`SELECT count(*) AS n FROM users WHERE role <> 'user' AND ms_sub IS NOT NULL`);
  assert.equal(Number(r.n), 0);
});
await refused('wrong nonce in the ID token', (c) => msSignIn(c, { sub: newSub, email: newEmail, nonce: 'other' }), 'failed');
await refused('ID token for another client (aud)', (c) => msSignIn(c, { sub: newSub, email: newEmail, aud: 'another-app' }), 'failed');
await refused('ID token whose issuer is another tenant than its tid', (c) => msSignIn(c, { sub: newSub, email: newEmail, iss: `${idp.issuer}/${WORK}/v2.0` }), 'failed');
await refused('expired ID token', (c) => msSignIn(c, { sub: newSub, email: newEmail, exp: Math.floor(Date.now() / 1000) - 300 }), 'failed');
await refused('bad state', (c) => msSignIn(c, { sub: newSub, email: newEmail }, { tamper: (q) => { q.set('state', 'guess'); return q; } }), 'state');
await refused('no flow cookie (an attacker\'s link)', (c) => c.req('GET', '/api/auth/microsoft/callback?code=x&state=y'), 'state');
await refused('cancelled at Microsoft', async (c) => {
  const { p } = await start(c);
  return c.req('GET', `/api/auth/microsoft/callback?error=access_denied&state=${p.get('state')}`);
}, 'cancelled');
await refused('a code used once cannot be replayed', async (c) => {
  const { p } = await start(c);
  const code = `code-replay-${stamp}`;
  idp.registerCode(code, { iss: `${idp.issuer}/${PERSONAL}/v2.0`, aud: CLIENT_ID, tid: PERSONAL, nonce: p.get('nonce'), sub: newSub, email: newEmail },
    { challenge: p.get('code_challenge'), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const first = await c.req('GET', `/api/auth/microsoft/callback?code=${code}&state=${p.get('state')}`);
  assert.ok(okSignIn(first));
  c.cookies.delete('access_token'); c.cookies.delete('refresh_token');
  const again = await start(c);
  return c.req('GET', `/api/auth/microsoft/callback?code=${code}&state=${again.p.get('state')}`);
}, 'failed');
await check('the failures are in the activity log with provider=microsoft and no token or email', async () => {
  const rows = (await db.query(`SELECT actor, details FROM audit_log WHERE action = 'auth.oauth_failed' AND details->>'provider' = 'microsoft'`)).rows;
  const reasons = new Set(rows.map((r) => r.details.reason));
  for (const want of ['unverified_email', 'no_email', 'staff', 'nonce', 'state', 'provider_access_denied']) assert.ok(reasons.has(want), `no ${want}`);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(unverified) && !text.includes('eyJ'), 'an email or a token reached the log');
});

// --- the cross-site exception covers the Microsoft callback as a navigation only ------------
await check('cross-site: the callback passes as a top-level navigation; start does not', async () => {
  const cb = await jar().req('GET', '/api/auth/microsoft/callback?state=x', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(cb.status, 302);
  const cbFetch = await jar().req('GET', '/api/auth/microsoft/callback?state=x', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' });
  assert.equal(cbFetch.status, 403);
  const s = await jar().req('GET', '/api/auth/microsoft/start', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
  assert.equal(s.status, 403);
});
await check('return_to cannot leave the site', async () => {
  const c = jar();
  const r = await msSignIn(c, { sub: newSub, email: newEmail }, { returnTo: '//evil.example.test/x' });
  assert.ok(loc(r).startsWith('/?signin=ok'), loc(r));
});

await idp.close();
await db.end();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
