// End-to-end checks of the internal API (/api/internal/v1) against a LOCAL server and its database.
//   INTERNAL_API_SECRET=<same as the server's> BASE=http://localhost:3100 DATABASE_URL=postgresql://... node test/e2e-internal-api.mjs
// The server must run with INTERNAL_API_SECRET (≥ 32 chars) and ENABLE_SALESFORCE off. The DB is used only to
// expire one test token and to pre-spend one test token's people budget. Never point this at production.
import assert from 'node:assert/strict';
import { staffLogin } from './helpers/staffLogin.mjs';
import crypto from 'node:crypto';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { signUp as codeSignUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('local servers only');
const SECRET = process.env.INTERNAL_API_SECRET || '';
if (SECRET.length < 32) throw new Error('set INTERNAL_API_SECRET (the one the local server runs with, ≥ 32 chars)');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password-123';
// The content manager and the admin may both issue people scopes; candidates may not hold tokens at all.
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const CM_PASSWORD = process.env.CM_PASSWORD || 'dev-content-password-123';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const jar = () => {
  const cookies = new Map();
  return {
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
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
};
// Server-to-server: no cookies at all, only the Authorization header.
const api = async (bearer, method, path, body, headers = {}) => {
  const h = { ...headers };
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api/internal/v1${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let json; try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
  return { status: res.status, json, buf, headers: res.headers };
};

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};

const admin = jar(); // admin: security + everything a content manager does
const cm = jar();    // content manager: jobs and candidates
const stamp = Date.now();
// Staff sign in only with "Continue with Google" (xhostd SSO; a mock here, see helpers/staffLogin.mjs).
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'admin login');
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'content manager login');

const mint = async (name, scopes, expiresInDays) => {
  // Only an admin issues keys (owner, 20.11.2026).
  const r = await admin.req('POST', '/api/admin/api-tokens', { name: `${name} ${stamp}`, scopes, expiresInDays });
  assert.equal(r.status, 201, r.text);
  return r.json.data;
};

// --- setup: a candidate with a CV who applied to a job ---
const pdf = async () => { const d = await PDFDocument.create(); d.addPage().drawText('Test CV'); return Buffer.from(await d.save()); };
const upTok = crypto.randomUUID();
const fd = new FormData();
fd.append('file', new Blob([await pdf()], { type: 'application/pdf' }), 'cv_internal.pdf');
assert.equal((await jar().req('POST', `/api/files/${upTok}`, fd, { form: true })).status, 200, 'upload');
const cand = jar();
const signUp = await codeSignUp(cand, {
  firstName: 'Internal', lastName: 'Api', email: `e2e-int-${stamp}@example.test`, phoneNumber: `05${String(stamp).slice(-8)}`,
  dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000,
  skills: [], cvFileUrl: `${upTok}/cv_internal.pdf`, hasAppliedToJob: false, consent: true,
});
assert.equal(signUp.status, 200, signUp.text);
const candidateId = signUp.json.data._id;

let jobId;
let applicationId;

// --- auth ---
await check('token management is staff-only (anonymous and candidates refused)', async () => {
  assert.notEqual((await jar().req('GET', '/api/admin/api-tokens')).status, 200);
  // Its own session: a candidate trying an admin route is signed out (by design).
  const other = jar();
  assert.equal((await candidateLogin(other, `e2e-int-${stamp}@example.test`)).status, 200);
  assert.notEqual((await other.req('POST', '/api/admin/api-tokens', { name: 'x', scopes: ['jobs:read'] })).status, 201);
});

await check('creating a token: bad scopes / expiry over 90 days refused; the token is shown once, stored as a hash', async () => {
  assert.equal((await admin.req('POST', '/api/admin/api-tokens', { name: 'x', scopes: ['admin'] })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/api-tokens', { name: 'x', scopes: ['jobs:read'], expiresInDays: 91 })).status, 400);
  const t = await mint('default expiry', ['jobs:read']);
  assert.match(t.token, /^skzi_[0-9a-f]{8}_/);
  const days = (new Date(t.expiresAt) - Date.now()) / 86400_000;
  assert.ok(days > 29.9 && days <= 30.01, `default expiry ${days}`);
  const list = await admin.req('GET', '/api/admin/api-tokens');
  assert.ok(!list.text.includes(t.token) && !/token_hash/.test(list.text));
  const row = (await db.query(`SELECT token_hash FROM api_tokens WHERE prefix = $1`, [t.prefix])).rows[0];
  assert.equal(row.token_hash, crypto.createHash('sha256').update(t.token).digest('hex'));
  const logged = await db.query(`SELECT 1 FROM audit_log WHERE action = 'api_token.created' AND target = $1`, [`token:${t.prefix}`]);
  assert.equal(logged.rowCount, 1);
});

await check('only the admin issues keys (people scopes too, logged as the issuer); a content manager is refused', async () => {
  const p = await admin.req('POST', '/api/admin/api-tokens', { name: `admin people ${stamp}`, scopes: ['candidates:read', 'cvs:read'] });
  assert.equal(p.status, 201, p.text);
  const created = await db.query(`SELECT 1 FROM audit_log WHERE action = 'api_token.created' AND actor = $1 AND target = $2`, [ADMIN_EMAIL, `token:${p.json.data.prefix}`]);
  assert.equal(created.rowCount, 1, 'admin people-scope token not logged as the admin');
  assert.equal((await admin.req('POST', `/api/admin/api-tokens/${p.json.data.id}/revoke`, {})).status, 200);
  // The admin is offered every scope (a content manager's refusal is checked at the end: it signs them out).
  assert.equal((await admin.req('GET', '/api/admin/api-tokens')).json.data.issuable.length, 6);
  assert.equal((await admin.req('POST', '/api/admin/api-tokens', { name: `admin sf ${stamp}`, scopes: ['jobs:read', 'salesforce:push'] })).status, 201);
});

await check('the admin sees every token and can revoke one, effective at once', async () => {
  const t = await mint('token to revoke', ['candidates:read']);
  assert.equal((await api(t.token, 'GET', '/candidates?limit=1')).status, 200);
  const seenByAdmin = (await admin.req('GET', '/api/admin/api-tokens')).json.data.tokens.find((x) => x.prefix === t.prefix);
  assert.ok(seenByAdmin, 'admin does not see the token');
  assert.equal(seenByAdmin.createdBy, ADMIN_EMAIL);
  const r = await admin.req('POST', `/api/admin/api-tokens/${t.id}/revoke`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.revokedBy, ADMIN_EMAIL);
  const after = await api(t.token, 'GET', '/candidates?limit=1');
  assert.equal(after.status, 401); assert.equal(after.json.code, 'token_revoked');
});

const reader = await mint('reader', ['jobs:read']);
await check('no token → 401; a garbage token → 401', async () => {
  const a = await api(null, 'GET', '/jobs');
  assert.equal(a.status, 401); assert.equal(a.json.code, 'no_token');
  const b = await api(`skzi_00000000_${'a'.repeat(43)}`, 'GET', '/jobs');
  assert.equal(b.status, 401); assert.equal(b.json.code, 'invalid_token');
  assert.equal((await api('not-a-token', 'GET', '/jobs')).status, 401);
});

await check('a signed-in admin\'s cookies give nothing on the internal API (no user-JWT path)', async () => {
  const r = await admin.req('GET', '/api/internal/v1/jobs');
  assert.equal(r.status, 401);
});

await check('wrong scope → 403 and the refusal is logged against the token', async () => {
  const r = await api(reader.token, 'GET', '/candidates');
  assert.equal(r.status, 403); assert.equal(r.json.code, 'insufficient_scope');
  assert.equal((await api(reader.token, 'POST', '/jobs', {})).status, 403);
  const logged = await db.query(`SELECT details FROM audit_log WHERE action = 'access.denied' AND actor = $1`, [`token:${reader.prefix}`]);
  assert.ok(logged.rows.some((x) => String(x.details.reason).startsWith('internal_api:scope')), JSON.stringify(logged.rows));
});

await check('the right scope works, and last-used time is recorded', async () => {
  const r = await api(reader.token, 'GET', '/jobs?limit=5');
  assert.equal(r.status, 200, r.buf.toString());
  assert.ok(Array.isArray(r.json.data.jobs));
  const list = (await admin.req('GET', '/api/admin/api-tokens')).json.data.tokens;
  await new Promise((res) => setTimeout(res, 200));
  const again = (await admin.req('GET', '/api/admin/api-tokens')).json.data.tokens.find((t) => t.prefix === reader.prefix);
  assert.ok(again.lastUsedAt || list.find((t) => t.prefix === reader.prefix).lastUsedAt, 'lastUsedAt not set');
});

await check('a revoked token → 401 (token_revoked), at once', async () => {
  const t = await mint('to revoke', ['jobs:read']);
  assert.equal((await api(t.token, 'GET', '/jobs')).status, 200);
  assert.equal((await admin.req('POST', `/api/admin/api-tokens/${t.id}/revoke`, {})).status, 200);
  const r = await api(t.token, 'GET', '/jobs');
  assert.equal(r.status, 401); assert.equal(r.json.code, 'token_revoked');
  const logged = await db.query(`SELECT 1 FROM audit_log WHERE action = 'api_token.revoked' AND target = $1`, [`token:${t.prefix}`]);
  assert.equal(logged.rowCount, 1);
});

await check('an expired token → 401 (token_expired)', async () => {
  const t = await mint('to expire', ['jobs:read'], 1);
  assert.equal((await api(t.token, 'GET', '/jobs')).status, 200);
  await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE prefix = $1`, [t.prefix]);
  const r = await api(t.token, 'GET', '/jobs');
  assert.equal(r.status, 401); assert.equal(r.json.code, 'token_expired');
});

await check('the server secret works with every scope, as system:internal-api', async () => {
  assert.equal((await api(SECRET, 'GET', '/jobs?limit=1')).status, 200);
  assert.equal((await api(`${SECRET}x`, 'GET', '/jobs?limit=1')).status, 401);
  const r = await api(SECRET, 'GET', `/candidates/${candidateId}`);
  assert.equal(r.status, 200, r.buf.toString());
  const logged = await db.query(`SELECT 1 FROM audit_log WHERE action = 'candidates.shown' AND actor = 'system:internal-api' AND details @> $1::jsonb`,
    [JSON.stringify({ ids: [candidateId] })]);
  assert.ok(logged.rowCount >= 1);
});

await check('a browser on another site is refused even with a valid token (cross-site rule kept)', async () => {
  const r = await api(SECRET, 'GET', '/jobs', null, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
  assert.equal(r.status, 403); assert.equal(r.json.code, 'cross_site');
});

// --- jobs ---
const writer = await mint('writer', ['jobs:read', 'jobs:write']);
await check('jobs: create (Suspended), list includes non-public statuses, get, update', async () => {
  const c = await api(writer.token, 'POST', '/jobs', {
    title: `Internal API job ${stamp}`, jobScope: ['FullTime'], companyName: 'Int Co', publishDate: new Date().toISOString(),
    citySymbol: 9000, description: '<p>ok</p><script>x</script>', uploadBy: 'internal-api', status: 'Suspended',
    requiredSkills: [], comments: 'internal note', isSponsored: false, isMarked: false, isSelfApply: false,
  });
  assert.equal(c.status, 201, c.buf.toString());
  jobId = c.json.data._id;
  assert.ok(!c.json.data.description.includes('script'));
  const l = await api(writer.token, 'GET', '/jobs?status=Suspended&limit=50');
  assert.ok(l.json.data.jobs.some((j) => j._id === jobId));
  const g = await api(writer.token, 'GET', `/jobs/${jobId}`);
  assert.equal(g.json.data.comments, 'internal note');
  assert.equal((await api(writer.token, 'PATCH', `/jobs/${jobId}`, { status: 'Active' })).status, 200);
  assert.equal((await api(writer.token, 'PATCH', `/jobs/${jobId}`, { role: 'admin' })).status, 400);
  assert.equal((await api(writer.token, 'GET', '/jobs?status=Nope')).status, 400);
  const pub = await jar().req('GET', `/api/jobs/${jobId}`);
  assert.equal(pub.json.data.status, 'Active');
  assert.ok(!('comments' in pub.json.data));
});

// --- applications + CV ---
const appReader = await mint('applications', ['applications:read', 'cvs:read']);
await check('applications: list / get with a CV link, never the storage key; CV link needs cvs:read', async () => {
  const ap = await cand.req('POST', `/api/jobs/apply/${jobId}`);
  assert.equal(ap.status, 200, ap.text);
  const l = await api(appReader.token, 'GET', `/applications?jobId=${jobId}`);
  assert.equal(l.status, 200, l.buf.toString());
  assert.equal(l.json.data.applications.length, 1);
  const a = l.json.data.applications[0];
  applicationId = a.id;
  assert.equal(a.candidateId, candidateId);
  assert.equal(a.cvLink, `/api/internal/v1/applications/${a.id}/cv`);
  assert.ok(!l.buf.toString().includes('post-scan/'), 'storage key leaked');
  const g = await api(appReader.token, 'GET', `/applications/${a.id}`);
  assert.equal(g.json.data.id, a.id);
  const cv = await api(appReader.token, 'GET', `/applications/${a.id}/cv`);
  assert.equal(cv.status, 200);
  assert.equal(cv.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await api(reader.token, 'GET', `/applications/${a.id}/cv`)).status, 403);
  const logged = await db.query(`SELECT 1 FROM audit_log WHERE action = 'candidate.cv_opened' AND actor = $1 AND target = $2`,
    [`token:${appReader.prefix}`, candidateId]);
  assert.equal(logged.rowCount, 1);
});

// A key's daily limits are its ISSUER's (all keys here are the admin's): what the admin already spent today
// (screens or other keys) counts too.
const cmUsed = async (actions) => (await db.query(
  `SELECT COALESCE(SUM((details->>'count')::int), 0)::int AS n FROM audit_log
    WHERE (actor = $1 OR details @> jsonb_build_object('budget_owner', $1::text))
      AND at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem' AND action = ANY($2) AND details ? 'count'`,
  [ADMIN_EMAIL, actions])).rows[0].n;

await check('CVs through a key count against its issuer: the 40/day limit → 429, alerts on the issuer', async () => {
  const t = await mint('cv limit', ['applications:read', 'cvs:read']);
  const before = await cmUsed(['candidate.cv_opened']);
  let ok = 0; let last;
  for (let i = 0; i < 41; i++) {
    last = await api(t.token, 'GET', `/applications/${applicationId}/cv`);
    if (last.status === 200) ok++; else break;
  }
  assert.equal(before + ok, 40, `before ${before} + ok ${ok}`);
  assert.equal(last.status, 429); assert.equal(last.json.code, 'limit_cvs');
  const alerts = await db.query(`SELECT kind FROM security_alerts WHERE user_email = $1`, [ADMIN_EMAIL]);
  assert.ok(['cvs_limit', 'cvs_many'].every((k) => alerts.rows.some((r) => r.kind === k)), JSON.stringify(alerts.rows));
  const perKey = await db.query(`SELECT 1 FROM security_alerts WHERE user_email = $1`, [`token:${t.prefix}`]);
  assert.equal(perKey.rowCount, 0, 'alerts are no longer per key');
  // The entries name the key as actor and the issuer as budget owner.
  const e = await db.query(`SELECT details FROM audit_log WHERE action = 'candidate.cv_opened' AND actor = $1 ORDER BY id DESC LIMIT 1`, [`token:${t.prefix}`]);
  assert.equal(e.rows[0].details.budget_owner, ADMIN_EMAIL);
});

await check('the budget is counted on the issuer: a NEW key of the same person is refused at once, so is their screen', async () => {
  const t2 = await mint('cv limit second key', ['applications:read', 'cvs:read']);
  const r = await api(t2.token, 'GET', `/applications/${applicationId}/cv`);
  assert.equal(r.status, 429, 'a second key started with a fresh allowance');
  assert.equal((await admin.req('GET', `/api/files/${candidateId}`)).status, 429, 'the issuer\'s own screen is not on the same budget');
});

await check('candidates through a key hit the issuer\'s daily people limit (1,500) → 429', async () => {
  const t1 = await mint('people ok', ['candidates:read']);
  const ok = await api(t1.token, 'GET', '/candidates?limit=5&search=Internal');
  assert.equal(ok.status, 200, ok.buf.toString());
  assert.ok(!/password|post-scan\//.test(ok.buf.toString()));
  // 5b: that there was a search is logged, never the text.
  const shown = await db.query(`SELECT details FROM audit_log WHERE action = 'candidates.shown' AND actor = $1 ORDER BY id DESC LIMIT 1`, [`token:${t1.prefix}`]);
  assert.equal(shown.rows[0].details.filters.search, true);
  assert.ok(!JSON.stringify(shown.rows[0].details).includes('Internal'));
  const t = await mint('people limit', ['candidates:read']);
  // The issuer spent the whole day on the screen (one log entry; the log is the counter), then a key asks.
  await db.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ($1, 'candidates.shown', 'e2e', $2)`,
    [ADMIN_EMAIL, JSON.stringify({ ids: [], count: 1500 })]);
  // Someone the issuer has not seen today (people already seen today do not count again).
  const fresh = await codeSignUp(jar(), {
    firstName: 'Fresh', lastName: 'Person', email: `e2e-fresh-${stamp}@example.test`, phoneNumber: `053${String(stamp + 7).slice(-7)}`,
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000,
    skills: [], cvFileUrl: '', hasAppliedToJob: false, consent: true,
  });
  assert.equal(fresh.status, 200, fresh.text);
  const one = await api(t.token, 'GET', `/candidates/${fresh.json.data._id}`);
  assert.equal(one.status, 429, one.buf.toString()); assert.equal(one.json.code, 'limit_people');
  const list = await api(t.token, 'GET', '/candidates?limit=5');
  assert.equal(list.status, 429);
  const alerts = await db.query(`SELECT kind FROM security_alerts WHERE user_email = $1`, [ADMIN_EMAIL]);
  assert.ok(alerts.rows.some((r) => r.kind === 'people_limit'));
  assert.equal((await api(t.token, 'GET', '/applications?limit=1')).status, 403); // no applications:read on this token
});

// --- a key stands only while its issuer does ---
const newStaff = async (label) => {
  const email = `e2e-issuer-${label}-${stamp}@example.test`;
  const add = await admin.req('POST', '/api/admin/staff', { email, role: 'admin' });
  assert.equal(add.status, 200, add.text);
  const j = jar();
  assert.equal((await staffLogin(j, email)).status, 200, `${label} login`);
  const id = (await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0].id;
  const r = await j.req('POST', '/api/admin/api-tokens', { name: `issuer ${label} ${stamp}`, scopes: ['jobs:read', 'candidates:read'] });
  assert.equal(r.status, 201, r.text);
  return { email, id, key: r.json.data, client: j };
};

await check('a deactivated issuer\'s key is refused (401 token_issuer_inactive) and revoked, logged with the reason', async () => {
  const s = await newStaff('deact');
  const row = await db.query(`SELECT created_by_user_id FROM api_tokens WHERE prefix = $1`, [s.key.prefix]);
  assert.equal(row.rows[0].created_by_user_id, s.id, 'the issuer id is stored');
  assert.equal((await api(s.key.token, 'GET', '/jobs?limit=1')).status, 200);
  assert.equal((await admin.req('POST', `/api/admin/staff/${s.id}/deactivate`)).status, 200);
  const r = await api(s.key.token, 'GET', '/jobs?limit=1');
  assert.equal(r.status, 401);
  assert.ok(['token_revoked', 'token_issuer_inactive'].includes(r.json.code), r.json.code);
  const revoked = await db.query(`SELECT details FROM audit_log WHERE action = 'api_token.revoked' AND target = $1`, [`token:${s.key.prefix}`]);
  assert.equal(revoked.rows[0]?.details?.reason, 'issuer_deactivated');
  // Even if the revocation were undone, the gate refuses on the issuer's state.
  await db.query(`UPDATE api_tokens SET revoked_at = NULL WHERE prefix = $1`, [s.key.prefix]);
  const again = await api(s.key.token, 'GET', '/jobs?limit=1');
  assert.equal(again.status, 401); assert.equal(again.json.code, 'token_issuer_inactive');
});

await check('a key whose issuer\'s DB role no longer allows its scopes is refused (token_issuer_role); role change revokes', async () => {
  const s = await newStaff('role');
  assert.equal((await api(s.key.token, 'GET', '/jobs?limit=1')).status, 200);
  // The role changes behind the staff screen's back: the gate still reads the DB role on every use.
  await db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [s.id]);
  const r = await api(s.key.token, 'GET', '/jobs?limit=1');
  assert.equal(r.status, 401); assert.equal(r.json.code, 'token_issuer_role');
  await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [s.id]);
  // Through the staff screen: the keys are revoked too.
  assert.equal((await admin.req('PATCH', `/api/admin/staff/${s.id}/role`, { role: 'content_manager' })).status, 200);
  const after = await api(s.key.token, 'GET', '/jobs?limit=1');
  assert.equal(after.status, 401); assert.equal(after.json.code, 'token_revoked');
  const revoked = await db.query(`SELECT details FROM audit_log WHERE action = 'api_token.revoked' AND target = $1`, [`token:${s.key.prefix}`]);
  assert.equal(revoked.rows[0]?.details?.reason, 'issuer_role_changed');
});

await check('revoke sessions also revokes the person\'s keys (reason issuer_sessions_revoked)', async () => {
  const s = await newStaff('sess');
  assert.equal((await admin.req('POST', `/api/admin/staff/${s.id}/revoke-sessions`)).status, 200);
  assert.equal((await api(s.key.token, 'GET', '/jobs?limit=1')).status, 401);
  const revoked = await db.query(`SELECT details FROM audit_log WHERE action = 'api_token.revoked' AND target = $1`, [`token:${s.key.prefix}`]);
  assert.equal(revoked.rows[0]?.details?.reason, 'issuer_sessions_revoked');
});

// --- Salesforce ---
const sf = await mint('salesforce', ['salesforce:push']);
await check('Salesforce push refuses while ENABLE_SALESFORCE is off (409), nothing recorded as pushed', async () => {
  for (const path of [`/salesforce/jobs/${jobId}/push`, `/salesforce/applications/${applicationId}/push`,
    `/salesforce/candidates/${candidateId}/push`, '/salesforce/push-pending']) {
    const r = await api(sf.token, 'POST', path, {});
    assert.equal(r.status, 409, `${path}: ${r.status}`); assert.equal(r.json.code, 'salesforce_disabled');
  }
  const s = await api(sf.token, 'GET', '/salesforce/sync');
  assert.equal(s.status, 200);
  assert.equal(s.json.data.enabled, false);
  const pushed = await db.query(`SELECT 1 FROM audit_log WHERE action = 'salesforce.pushed' AND actor = $1`, [`token:${sf.prefix}`]);
  assert.equal(pushed.rowCount, 0);
  assert.equal((await api(reader.token, 'POST', '/salesforce/push-pending', {})).status, 403);
});

await check('a content manager has no key screen: list and create are refused, nothing is issued', async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM api_tokens`)).rows[0].n;
  assert.notEqual((await cm.req('GET', '/api/admin/api-tokens')).status, 200);
  const cm2 = jar();
  assert.equal((await staffLogin(cm2, CM_EMAIL)).status, 200, 'content manager login again');
  assert.notEqual((await cm2.req('POST', '/api/admin/api-tokens', { name: `cm people ${stamp}`, scopes: ['candidates:read', 'cvs:read'] })).status, 201);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM api_tokens`)).rows[0].n, before);
});

// cleanup: the test job leaves the public list
await api(writer.token, 'PATCH', `/jobs/${jobId}`, { status: 'Closed' });
await db.end();

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
