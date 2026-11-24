// Live security checks against a LOCAL server and its database (never production).
// Run it on a FRESH database: it spends the content manager's daily CV budget and expects to cross the alert line itself.
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... ADMIN_EMAIL=... ADMIN_PASSWORD=... CM_EMAIL=... CM_PASSWORD=... node test/live-security.mjs
// Staff sign in only with "Continue with Google" (xhostd SSO): start the server with the mock values in helpers/staffLogin.mjs.
// Covers: limit race (N parallel at one slot left → exactly one passes), strict hand-over when the log fails,
// append-only trigger, role read from the DB, revoked refresh token, staff revoke, cross-site refusal, page cap,
// roles (an admin sees candidates too, counted and logged like a content manager; only admins grant), revoke sessions
// and deactivation take effect at once, no lock-out race between two admins, and the one-time role split migration.
import assert from 'node:assert/strict';
import { staffLogin, xhostdSignIn, signedInOk } from './helpers/staffLogin.mjs';
import crypto from 'node:crypto';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('local servers only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password-123';
const CM_EMAIL = (process.env.CM_EMAIL || 'content@example.test').toLowerCase();
const CM_PASSWORD = process.env.CM_PASSWORD || 'dev-content-password-123';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const jar = () => {
  const cookies = new Map();
  return {
    cookies,
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, { form = false, headers = {} } = {}) {
      const h = { ...headers };
      if (cookies.size) h.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body && !form) h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: form ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'); const [k, v] = kv.split('=');
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      let json; try { json = JSON.parse(buf.toString()); } catch { json = null; }
      return { status: res.status, json, buf, headers: res.headers };
    },
  };
};
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const pdf = async () => { const d = await PDFDocument.create(); d.addPage().drawText('CV'); return Buffer.from(await d.save()); };
const stamp = Date.now();
/** `byCode`: a sign-in code by email (candidates; dev endpoint for the code). Else "Continue with Google"
 *  (xhostd SSO, mock) — the only way for staff. */
const login = async (email, byCode = false) => {
  const j = jar();
  const r = byCode ? await candidateLogin(j, email) : await staffLogin(j, email);
  assert.equal(r.status, 200, `login ${email}: ${r.buf}`);
  return j;
};
const idOf = async (email) => (await db.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email])).rows[0].id;

// --- setup: content manager (`cm`), admin (`sec`), a candidate with a CV ---
let cm = await login(CM_EMAIL);
let sec = await login(ADMIN_EMAIL);
const cand = jar();
const token = crypto.randomUUID();
const fd = new FormData(); fd.append('file', new Blob([await pdf()], { type: 'application/pdf' }), 'cv.pdf');
assert.equal((await cand.req('POST', `/api/files/${token}`, fd, { form: true })).status, 200, 'upload');
const candEmail = `live-${stamp}@example.test`;
const signup = await signUp(cand, {
  firstName: 'Live', lastName: 'Test', email: candEmail, phoneNumber: `05${String(stamp).slice(-8)}`,
  citySymbol: 3000, gender: 'other', dateOfBirth: '1990-01-01T00:00:00.000Z', cvFileUrl: `${token}/cv.pdf`, consent: true,
});
assert.equal(signup.status, 200, `signup ${signup.buf}`);
const candId = signup.json.data._id;
const setRole = (id, role) => db.query(`UPDATE users SET role = $1, deactivated_at = NULL WHERE id = $2`, [role, id]);
const cvsAllowed = async () => {
  const s = (await sec.req('GET', '/api/admin/security')).json.data;
  const u = s.usage.find((x) => x.actor === CM_EMAIL);
  return { used: u?.cvs.used ?? 0, allowed: u?.cvs.allowed ?? s.limits.cvs.daily, summary: s };
};

await check('login answer carries no tokens in the body', async () => {
  const r = await candidateLogin(jar(), candEmail);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.accessToken, undefined);
  assert.equal(r.json.data.refreshToken, undefined);
});

await check('candidates list: at most 50 per request, recorded with the ids shown, no staff accounts', async () => {
  const r = await cm.req('GET', '/api/users?usersFilter[limit]=500&usersFilter[page]=1');
  assert.equal(r.status, 200, String(r.buf));
  assert.ok(r.json.data.users.length <= 50);
  assert.ok(r.json.data.users.every((u) => u.role === 'user'), 'a staff account is in the candidates list');
  const log = (await sec.req('GET', `/api/admin/audit?subject=${candId}`)).json.data.entries;
  assert.ok(log.some((e) => e.action === 'candidates.shown' && e.actor === CM_EMAIL), 'no candidates.shown entry for the candidate');
});

await check('CV open: sandboxed response headers, and "who saw" finds it by email', async () => {
  const r = await cm.req('GET', `/api/files/${candId}`);
  assert.equal(r.status, 200);
  assert.ok(r.buf.subarray(0, 4).toString() === '%PDF');
  assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  const log = (await sec.req('GET', `/api/admin/audit?subject=${encodeURIComponent(candEmail)}`)).json.data.entries;
  assert.ok(log.some((e) => e.action === 'candidate.cv_opened' && e.actor === CM_EMAIL));
});

await check('the admin sees candidates too: list, CV, applications — inside the daily limits and strictly logged as the admin', async () => {
  const list = await sec.req('GET', '/api/users?usersFilter[page]=1');
  assert.equal(list.status, 200, String(list.buf));
  const cv = await sec.req('GET', `/api/files/${candId}`);
  assert.equal(cv.status, 200);
  assert.ok(cv.buf.subarray(0, 4).toString().startsWith('%PDF'));
  assert.equal((await sec.req('GET', `/api/users/job-applications/${candId}`)).status, 200);
  const log = (await sec.req('GET', `/api/admin/audit?subject=${candId}&actor=${encodeURIComponent(ADMIN_EMAIL)}`)).json.data.entries;
  for (const a of ['candidates.shown', 'candidate.cv_opened', 'candidate.applications_viewed']) {
    assert.ok(log.some((e) => e.action === a && e.actor === ADMIN_EMAIL), `${a} by the admin not logged`);
  }
  const s = (await sec.req('GET', '/api/admin/security')).json.data;
  const u = s.usage.find((x) => x.actor === ADMIN_EMAIL);
  assert.ok(u && u.cvs.used >= 1 && u.people.used >= 1, 'the admin is not counted in the daily limits');
});

await check('a content manager gets no security screen, log or staff users', async () => {
  for (const p of ['/api/admin/security', '/api/admin/audit', '/api/admin/staff']) {
    const c = await login(CM_EMAIL);
    assert.notEqual((await c.req('GET', p)).status, 200, `${p} answered 200 to a content manager`);
  }
  cm = await login(CM_EMAIL);
});

const fillCvs = async (n) => {
  if (n > 0) await db.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, 'candidate.cv_opened', 'test-fill', $2)`,
    [CM_EMAIL, JSON.stringify({ ids: [], count: n, test: true })]);
};

await check('alert when crossing the line: the open that reaches it raises "many today" for the admins', async () => {
  const { used, summary } = await cvsAllowed();
  await fillCvs(summary.limits.cvs.alertAt - used - 1);
  assert.equal((await cm.req('GET', `/api/files/${candId}`)).status, 200);
  const after = (await cvsAllowed()).summary;
  assert.ok(after.alerts.some((a) => a.kind === 'cvs_many' && a.user_email === CM_EMAIL), 'no cvs_many alert');
});

await check('limit race: 6 parallel CV opens with one slot left → exactly one passes, alert raised, admin grant reopens', async () => {
  const { used, allowed } = await cvsAllowed();
  await fillCvs(allowed - used - 1);
  const rs = await Promise.all(Array.from({ length: 6 }, () => cm.req('GET', `/api/files/${candId}`)));
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 429, 429, 429, 429, 429]);
  assert.match(rs.find((r) => r.status === 429).json.message, /מגבלה היומית/);
  const { summary } = await cvsAllowed();
  assert.ok(summary.alerts.some((a) => a.kind === 'cvs_limit' && a.user_email === CM_EMAIL), 'no cvs_limit alert');
  // budgets are for staff who see candidates (content managers and admins); a candidate gets no grant
  assert.equal((await sec.req('POST', '/api/admin/security/grant', { email: candEmail, budget: 'cvs' })).status, 404);
  const g = await sec.req('POST', '/api/admin/security/grant', { email: CM_EMAIL, budget: 'cvs' });
  assert.equal(g.status, 200, String(g.buf));
  assert.equal((await cm.req('GET', `/api/files/${candId}`)).status, 200);
});

await check('strict hand-over: when the log refuses the entry, no CV and no list are sent (503)', async () => {
  await db.query(`CREATE OR REPLACE FUNCTION test_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action IN ('candidate.cv_opened','candidates.shown') THEN RAISE EXCEPTION 'blocked by test'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER test_block_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_block_audit()`);
  try {
    const f = await cm.req('GET', `/api/files/${candId}`);
    assert.equal(f.status, 503);
    assert.ok(!f.buf.subarray(0, 4).toString().startsWith('%PDF'), 'the file was sent');
    const l = await cm.req('GET', '/api/users?usersFilter[page]=1');
    assert.equal(l.status, 503);
    assert.equal(l.json.data, undefined);
  } finally {
    await db.query(`DROP TRIGGER IF EXISTS test_block_audit ON audit_log`);
    await db.query(`DROP FUNCTION IF EXISTS test_block_audit()`);
  }
});

await check('the activity log is append-only (UPDATE, DELETE of recent rows, TRUNCATE refused; old rows purgeable)', async () => {
  await assert.rejects(db.query(`UPDATE audit_log SET actor = 'x' WHERE id = (SELECT max(id) FROM audit_log)`), /cannot be changed/);
  await assert.rejects(db.query(`DELETE FROM audit_log WHERE id = (SELECT max(id) FROM audit_log)`), /kept for 24 months/);
  await assert.rejects(db.query(`TRUNCATE audit_log`), /cannot be truncated/);
  await db.query(`INSERT INTO audit_log (at, actor, action) VALUES (now() - interval '25 months', 'test', 'test.old')`);
  const del = await db.query(`DELETE FROM audit_log WHERE action = 'test.old' AND at < now() - make_interval(months => 24)`);
  assert.equal(del.rowCount, 1);
});

await check('role is read from the DB on every request (promote → in, demote → out; each role only its own area)', async () => {
  assert.notEqual((await cand.req('GET', '/api/users')).status, 200);
  // A CODE-BY-EMAIL session gets no staff access when its account becomes staff (staff = xhostd SSO only) ...
  const cp = await login(candEmail, true);
  await setRole(candId, 'admin');
  assert.notEqual((await cp.req('GET', '/api/admin/security')).status, 200, 'an email-code session got staff access');
  await setRole(candId, 'user');
  // ... an SSO session does (role from the DB on every request).
  const c2 = await login(candEmail);
  await setRole(candId, 'admin');
  assert.equal((await c2.req('GET', '/api/admin/security')).status, 200, 'promotion to admin not effective');
  await setRole(candId, 'user');
  assert.notEqual((await c2.req('GET', '/api/admin/security')).status, 200, 'demotion not effective');
  const c3 = await login(candEmail);
  await setRole(candId, 'content_manager');
  assert.equal((await c3.req('GET', '/api/users')).status, 200, 'promotion to content manager not effective');
  await setRole(candId, 'user');
  assert.notEqual((await c3.req('GET', '/api/users')).status, 200, 'demotion not effective');
});

await check('staff revoke (security screen): the revoked person is out at once; you cannot revoke yourself', async () => {
  const c3 = await login(candEmail);
  await setRole(candId, 'admin');
  assert.equal((await c3.req('GET', '/api/admin/security')).status, 200);
  assert.equal((await sec.req('POST', `/api/admin/security/admins/${candId}/revoke`)).status, 200);
  assert.notEqual((await c3.req('GET', '/api/admin/security')).status, 200);
  assert.equal((await sec.req('POST', `/api/admin/security/admins/${await idOf(ADMIN_EMAIL)}/revoke`)).status, 409);
  // a candidate id is not "staff": the security screen can't touch candidates
  assert.equal((await sec.req('POST', `/api/admin/security/admins/${candId}/revoke`)).status, 404);
});

await check('revoke sessions: a still-valid access token is refused at once, and it is logged', async () => {
  await setRole(candId, 'content_manager');
  const c5 = await login(candEmail);
  assert.equal((await c5.req('GET', '/api/users')).status, 200);
  assert.equal((await sec.req('POST', `/api/admin/staff/${candId}/revoke-sessions`)).status, 200);
  const access = [...c5.cookies].filter(([k]) => /access/i.test(k));
  const accessOnly = jar(); for (const [k, v] of access) accessOnly.cookies.set(k, v);
  assert.notEqual((await accessOnly.req('GET', '/api/users')).status, 200, 'old access token still works');
  assert.notEqual((await c5.req('GET', '/api/users')).status, 200, 'old session still works');
  const c6 = await login(candEmail);
  assert.equal((await c6.req('GET', '/api/users')).status, 200, 'a new login after the revoke is refused');
  const log = (await sec.req('GET', '/api/admin/audit?action=staff.sessions_revoked')).json.data.entries;
  assert.ok(log.some((e) => e.target === candEmail && e.actor === ADMIN_EMAIL));
});

await check('deactivate: no login, live session out at once; reactivate restores; self-deactivation refused', async () => {
  const c7 = await login(candEmail);
  assert.equal((await sec.req('POST', `/api/admin/staff/${candId}/deactivate`)).status, 200);
  assert.notEqual((await c7.req('GET', '/api/users')).status, 200, 'deactivated session still works');
  assert.ok(!signedInOk(await xhostdSignIn(jar(), candEmail)), 'a deactivated account signed in (SSO)');
  const r = await candidateLogin(jar(), candEmail);
  assert.notEqual(r.status, 200, 'a deactivated account signed in (code by email)');
  assert.equal((await sec.req('POST', `/api/admin/staff/${candId}/activate`)).status, 200);
  assert.equal((await (await login(candEmail)).req('GET', '/api/users')).status, 200);
  assert.equal((await sec.req('POST', `/api/admin/staff/${await idOf(ADMIN_EMAIL)}/deactivate`)).status, 409);
  await setRole(candId, 'user');
});

await check('lock-out: the last admin cannot be demoted; two admins demoting each other at once leave one admin', async () => {
  const me = await idOf(ADMIN_EMAIL);
  const admins = (await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deactivated_at IS NULL`)).rows[0].n;
  assert.equal(admins, 1, 'this check expects one admin (fresh DB)');
  assert.equal((await sec.req('PATCH', `/api/admin/staff/${me}/role`, { role: 'content_manager' })).status, 409);
  await setRole(candId, 'admin');
  const other = await login(candEmail);
  const [a, b] = await Promise.all([
    sec.req('PATCH', `/api/admin/staff/${candId}/role`, { role: 'user' }),
    other.req('PATCH', `/api/admin/staff/${me}/role`, { role: 'user' }),
  ]);
  const left = (await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND deactivated_at IS NULL`)).rows[0].n;
  assert.equal(left, 1, `admins left: ${left} (answers ${a.status}, ${b.status})`);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1, `answers ${a.status}, ${b.status}`);
  // restore: ADMIN_EMAIL admin, the candidate a candidate
  await setRole(me, 'admin');
  await setRole(candId, 'user');
  sec = await login(ADMIN_EMAIL);
});

await check('staff add: a candidate\'s account gets the staff role ADDED (stays a candidate); a new one is created without a password', async () => {
  // Several roles per account (owner, 23.11.2026).
  const add = await sec.req('POST', '/api/admin/staff', { email: candEmail, role: 'content_manager' });
  assert.equal(add.status, 200, String(add.buf));
  assert.ok(!String(add.buf).includes(candEmail));
  assert.deepEqual([...(await db.query(`SELECT roles FROM users WHERE id = $1`, [candId])).rows[0].roles].sort(), ['content_manager', 'user']);
  assert.equal((await sec.req('PATCH', `/api/admin/staff/${candId}/role`, { role: 'user' })).status, 200);
  assert.deepEqual((await db.query(`SELECT roles FROM users WHERE id = $1`, [candId])).rows[0].roles, ['user']);
  const newEmail = `staff-${stamp}@example.test`;
  const inv = await sec.req('POST', '/api/admin/staff', { email: newEmail, role: 'admin', firstName: 'New' });
  assert.equal(inv.status, 200, String(inv.buf));
  assert.equal(inv.json.data.created, true);
  const row = (await db.query(`SELECT role, password FROM users WHERE lower(email) = $1`, [newEmail])).rows[0];
  assert.equal(row.role, 'admin');
  assert.equal(row.password, '', 'the admin must not set the password');
  assert.equal((await sec.req('POST', '/api/admin/staff', { email: newEmail, role: 'superuser' })).status, 400);
  const list = (await sec.req('GET', '/api/admin/staff')).json.data.staff;
  assert.ok(list.some((s) => s.email === newEmail && s.invitePending));
  const log = (await sec.req('GET', '/api/admin/audit?action=staff.')).json.data.entries;
  assert.ok(log.some((e) => e.action === 'staff.invited' && e.target === newEmail && e.details.role === 'admin'));
  // tidy: the invited admin is deactivated (now 2 admins → allowed), the candidate back to candidate
  assert.equal((await sec.req('POST', `/api/admin/staff/${await idOf(newEmail)}/deactivate`)).status, 200);
  await setRole(candId, 'user');
});

await check('content managers cannot edit a staff account from the candidates screen', async () => {
  const r = await cm.req('PATCH', `/api/users/${await idOf(ADMIN_EMAIL)}`, { email: `taken-${stamp}@example.test` });
  assert.notEqual(r.status, 200);
  assert.equal((await db.query(`SELECT lower(email) AS e FROM users WHERE id = $1`, [await idOf(ADMIN_EMAIL)])).rows[0].e, ADMIN_EMAIL);
});

await check('a refresh token is dead after logout (also on routes that identify optionally)', async () => {
  const c4 = await login(candEmail);
  const refreshOnly = [...c4.cookies].filter(([k]) => /refresh/i.test(k));
  assert.equal(refreshOnly.length, 1, 'no refresh cookie');
  await c4.req('POST', '/api/logout');
  const stale = jar(); stale.cookies.set(refreshOnly[0][0], refreshOnly[0][1]);
  assert.notEqual((await stale.req('GET', `/api/users/job-applications/${candId}`)).status, 200);
});

await check('cross-site requests to the API are refused', async () => {
  const r = await sec.req('GET', '/api/admin/security', null, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal((await sec.req('GET', '/api/admin/security', null, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

await check('access review covers both staff roles: confirm sets 60 days, and is recorded', async () => {
  const s0 = (await sec.req('GET', '/api/admin/security')).json.data;
  assert.ok(s0.staff.some((a) => a.email === CM_EMAIL && a.role === 'content_manager'), 'content manager not under review');
  assert.ok(s0.staff.some((a) => a.email === ADMIN_EMAIL && a.role === 'admin'), 'admin not under review');
  for (const email of [ADMIN_EMAIL, CM_EMAIL]) {
    const id = await idOf(email);
    const prev = (await db.query(`SELECT valid_until FROM access_reviews WHERE user_id = $1 ORDER BY reviewed_at DESC LIMIT 1`, [id])).rows[0];
    const r = await sec.req('POST', `/api/admin/security/reviews/${id}`);
    assert.equal(r.status, 200);
    const base = prev && new Date(prev.valid_until) > new Date() ? new Date(prev.valid_until).getTime() : Date.now();
    const days = (new Date(r.json.data.validUntil) - base) / 86400_000;
    assert.ok(days > 59.99 && days <= 60.01, `valid for ${days} days past the base`);
  }
  const s = (await sec.req('GET', '/api/admin/security')).json.data;
  assert.equal(s.staff.find((a) => a.email === ADMIN_EMAIL).state, 'valid');
  assert.equal(s.staff.find((a) => a.email === CM_EMAIL).state, 'valid');
  assert.equal((await sec.req('POST', `/api/admin/security/reviews/${candId}`)).status, 404, 'a candidate was reviewed as staff');
});

await check('role split migration: once; the chosen admin stays admin, other former admins become content managers', async () => {
  process.env.ACCESS_TOKEN_SECRET ||= 'x'; process.env.REFRESH_TOKEN_SECRET ||= 'x'; process.env.RESET_TOKEN_SECRET ||= 'x';
  const { migrateRolesSplit, ROLES_SPLIT_MIGRATION, pool } = await import('../dist/config/db.js');
  const marker = (await db.query(`SELECT details FROM schema_migrations WHERE name = $1`, [ROLES_SPLIT_MIGRATION])).rows[0];
  assert.ok(marker, 'the migration did not record itself at boot');
  try {
    assert.equal(await migrateRolesSplit(), 'already applied');
    // Simulate the pre-split state: two admins, no marker.
    await db.query(`DELETE FROM schema_migrations WHERE name = $1`, [ROLES_SPLIT_MIGRATION]);
    await setRole(candId, 'admin');
    process.env.INITIAL_ADMIN_EMAIL = `nobody-${stamp}@example.test`;
    assert.equal(await migrateRolesSplit(), 'postponed');
    assert.equal((await db.query(`SELECT role FROM users WHERE id = $1`, [candId])).rows[0].role, 'admin', 'changed while postponed');
    process.env.INITIAL_ADMIN_EMAIL = ADMIN_EMAIL;
    assert.equal(await migrateRolesSplit(), 'applied');
    assert.equal((await db.query(`SELECT role FROM users WHERE id = $1`, [candId])).rows[0].role, 'content_manager');
    assert.equal((await db.query(`SELECT role FROM users WHERE id = $1`, [await idOf(ADMIN_EMAIL)])).rows[0].role, 'admin');
    assert.equal((await db.query(`SELECT role FROM users WHERE id = $1`, [await idOf(CM_EMAIL)])).rows[0].role, 'content_manager');
    assert.equal(await migrateRolesSplit(), 'already applied');
    const log = (await db.query(`SELECT details FROM audit_log WHERE action = 'staff.roles_split' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(log.details.admin, ADMIN_EMAIL);
  } finally {
    delete process.env.INITIAL_ADMIN_EMAIL;
    await setRole(candId, 'user');
    await db.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ROLES_SPLIT_MIGRATION, JSON.stringify({ test: true })]);
    await pool.end();
  }
});

await db.end();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
