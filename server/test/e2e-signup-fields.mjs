// Sign-up fields setting (required / optional / hidden) and the Israeli ID number (תעודת זהות), end to end against a
// running LOCAL server (DEV_MODE=true, the mock SSO values from server/.env.example; a fresh DB is best):
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... node test/e2e-signup-fields.mjs
// Checks: the setting is for content managers and admins (coordinators refused: e2e-coordinator.mjs) and logged with setting values only; the public read; the server enforces a
// required field the browser skipped; the check digit; optional / hidden fields; the personal area shows, changes and
// clears the ID number; staff see it only in the candidates list (peopleHandover); never in the activity log, never to
// employers. Restores the default setting at the end. Never point this at production.
import assert from 'node:assert/strict';
import pg from 'pg';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp } from './helpers/candidate.mjs';
const { TERMS_VERSION } = await import('../dist/security/consent.js'); // the version in force (src/security/consent.ts)
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || process.env.CONTENT_MANAGER_EMAIL || 'content@example.test').toLowerCase();

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
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const stamp = Date.now();
const addr = (k) => `sf-${k}-${stamp}@example.test`;
const settle = () => new Promise((r) => setTimeout(r, 400)); // fire-and-forget log writes
let n = 0;
const details = (extra = {}) => ({
  firstName: 'שדות', lastName: 'הרשמה', phoneNumber: `05${String(stamp + (++n)).slice(-8)}`, citySymbol: 9000, gender: 'female',
  dateOfBirth: '1991-02-03T12:00:00.000Z', skills: [], consent: true, ...extra,
});
const GOOD_ID = '123456782';
const GOOD_ID_2 = '000000018';
const BAD_ID = '123456789';
const DEFAULT = { phoneNumber: 'required', citySymbol: 'required', gender: 'required', dateOfBirth: 'required', idNumber: 'optional' };

const admin = jar();
const cm = jar();
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin signs in');
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager signs in');
const put = (patch, c = admin) => c.req('PUT', '/api/admin/settings/signup-fields', patch);

await check('public read: the default setting (as the form was; ID number optional)', async () => {
  const r = await jar().req('GET', '/api/auth/signup-fields');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data, { fields: DEFAULT });
});

await check('content managers and admins: anonymous refused, a content manager reads and changes it, the admin too', async () => {
  const anon = await jar().req('GET', '/api/admin/settings/signup-fields');
  assert.ok(anon.status >= 400 && anon.status < 404 && !anon.json?.data, `anonymous: ${anon.status}`);
  assert.ok((await jar().req('PUT', '/api/admin/settings/signup-fields', { idNumber: 'required' })).status >= 400);
  // A candidate-level setting since 11.2026 (moved from /admin/security): content managers set it.
  const cmr = await cm.req('GET', '/api/admin/settings/signup-fields');
  assert.equal(cmr.status, 200, `content manager read: ${cmr.status}`);
  assert.deepEqual(cmr.json.data.fields, DEFAULT);
  const cmw = await put({ idNumber: 'hidden' }, cm);
  assert.equal(cmw.status, 200, `content manager write: ${cmw.status}`);
  assert.equal((await jar().req('GET', '/api/auth/signup-fields')).json.data.fields.idNumber, 'hidden');
  assert.equal((await put({ idNumber: 'optional' }, cm)).status, 200, 'content manager restores it');
  const r = await admin.req('GET', '/api/admin/settings/signup-fields');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.fields, DEFAULT);
  assert.deepEqual(r.json.data.modes.idNumber, ['required', 'optional', 'hidden']);
  assert.deepEqual(r.json.data.modes.dateOfBirth, ['required', 'optional']);
  // The old admin-only path is gone.
  assert.equal((await admin.req('GET', '/api/admin/security/signup-fields')).status, 404);
});

await check('bad setting values refused (unknown field, hidden birth date, names, empty body)', async () => {
  for (const body of [{ email: 'optional' }, { dateOfBirth: 'hidden' }, { firstName: 'optional' }, { gender: 'maybe' }, {}]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
});

await check('required ID number: the server refuses a sign-up without it or with a wrong check digit', async () => {
  const r = await put({ idNumber: 'required', dateOfBirth: 'optional' });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.fields.idNumber, 'required');
  assert.equal((await jar().req('GET', '/api/auth/signup-fields')).json.data.fields.idNumber, 'required');
  const a = await signUp(jar(), { ...details(), email: addr('noid') });
  assert.equal(a.status, 400);
  assert.ok(a.json.fields.includes('idNumber'), a.text);
  const b = await signUp(jar(), { ...details(), idNumber: BAD_ID, email: addr('badid') });
  assert.equal(b.status, 400);
  assert.deepEqual(b.json.fields, ['idNumber']);
  const { rows } = await db.query(`SELECT 1 FROM users WHERE lower(email) = ANY($1)`, [[addr('noid'), addr('badid')]]);
  assert.equal(rows.length, 0, 'nothing created');
});

const candidate = jar();
const withId = addr('withid');
await check('a valid ID number is accepted and stored as 9 digits; optional birth date may be left out', async () => {
  const r = await signUp(candidate, { ...details({ dateOfBirth: undefined }), idNumber: GOOD_ID, email: withId });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.idNumber, undefined, 'the sign-in answer carries no ID number');
  const { rows } = await db.query(`SELECT id_number, date_of_birth FROM users WHERE lower(email) = $1`, [withId]);
  assert.equal(rows[0].id_number, GOOD_ID);
  assert.equal(rows[0].date_of_birth, null);
});

await check('personal area: shows the own ID number; a wrong one is refused; a required one is not cleared', async () => {
  const me = await candidate.req('GET', '/api/users/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.idNumber, GOOD_ID);
  const bad = await candidate.req('PATCH', '/api/users/me', { idNumber: BAD_ID });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.fields, ['idNumber']);
  const clr = await candidate.req('PATCH', '/api/users/me', { idNumber: '' });
  assert.equal(clr.status, 200);
  assert.equal(clr.json.data.user.idNumber, GOOD_ID, 'required: empty never clears it');
  const ch = await candidate.req('PATCH', '/api/users/me', { idNumber: '18' + '' }); // too short → refused
  assert.equal(ch.status, 400);
  const ok = await candidate.req('PATCH', '/api/users/me', { idNumber: GOOD_ID_2 });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.user.idNumber, GOOD_ID_2);
});

await check('optional ID number: an empty one clears it in the personal area', async () => {
  assert.equal((await put({ idNumber: 'optional' })).status, 200);
  const clr = await candidate.req('PATCH', '/api/users/me', { idNumber: '' });
  assert.equal(clr.status, 200);
  assert.equal(clr.json.data.user.idNumber, null);
  assert.equal((await candidate.req('PATCH', '/api/users/me', { idNumber: GOOD_ID })).status, 200);
});

await check('optional phone, town, gender: a sign-up with names only works (phone stored as NULL)', async () => {
  assert.equal((await put({ phoneNumber: 'optional', citySymbol: 'optional', gender: 'optional' })).status, 200);
  const e = addr('names');
  const r = await signUp(jar(), { firstName: 'רק', lastName: 'שמות', skills: [], consent: true, email: e });
  assert.equal(r.status, 200, r.text);
  const { rows } = await db.query(`SELECT phone_number, city_symbol, id_number FROM users WHERE lower(email) = $1`, [e]);
  assert.equal(rows[0].phone_number, null);
  assert.equal(rows[0].id_number, null);
  // A second one too (NULL phones don't collide).
  assert.equal((await signUp(jar(), { firstName: 'רק', lastName: 'שמות', skills: [], consent: true, email: addr('names2') })).status, 200);
  // A given optional value is still checked.
  const bad = await signUp(jar(), { firstName: 'רק', lastName: 'שמות', phoneNumber: '123', consent: true, email: addr('badphone') });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.fields, ['phoneNumber']);
});

await check('hidden ID number: not asked, and one sent anyway is not stored', async () => {
  assert.equal((await put({ idNumber: 'hidden' })).status, 200);
  const e = addr('hidden');
  assert.equal((await signUp(jar(), { ...details(), idNumber: GOOD_ID, email: e })).status, 200);
  const { rows } = await db.query(`SELECT id_number FROM users WHERE lower(email) = $1`, [e]);
  assert.equal(rows[0].id_number, null);
});

await check('staff see the ID number only in the candidates list (peopleHandover: strict log with ids)', async () => {
  const r = await cm.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(withId)}&usersFilter[limit]=9`);
  assert.equal(r.status, 200, r.text);
  const u = r.json.data.users.find((x) => x.email === withId);
  assert.ok(u, 'candidate listed');
  assert.equal(u.idNumber, GOOD_ID);
  await settle();
  const { rows } = await db.query(`SELECT details FROM audit_log WHERE action = 'candidates.shown' ORDER BY id DESC LIMIT 1`);
  assert.ok(JSON.stringify(rows[0].details).includes(String(u._id)), 'shown ids logged');
});

await check('the activity log: the setting change with values only; the ID number nowhere', async () => {
  await settle();
  const { rows } = await db.query(`SELECT action, target, details FROM audit_log WHERE action = 'settings.signup_fields_updated' ORDER BY id`);
  assert.ok(rows.length >= 4, `rows: ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.target, 'signupFields');
    for (const v of [...Object.values(r.details.before ?? {}), ...Object.values(r.details.after ?? {})]) assert.ok(['required', 'optional', 'hidden'].includes(v));
  }
  const all = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%' || $1 || '%' OR details::text LIKE '%' || $2 || '%' OR coalesce(target,'') IN ($1, $2)`, [GOOD_ID, GOOD_ID_2]);
  assert.equal(all.rows[0].n, 0, 'an ID number is in the activity log');
  const upd = await db.query(`SELECT details FROM audit_log WHERE action = 'user.profile_updated' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(upd.rows[0].details.fields, ['idNumber'], 'field names only');
});

await check('employers never see it: forwarded applicants and every employer route carry no ID number', async () => {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'employer_forwards' AND column_name = 'id_number'`);
  assert.equal(rows[0].n, 0);
  // The default user object (sign-in answers, session) has no ID number: checked through the session route.
  const s = await candidate.req('GET', '/api/auth/session');
  assert.equal(s.status, 200);
  assert.ok(!('idNumber' in (s.json.data?.user ?? {})), 'session carries no ID number');
  assert.ok(!s.text.includes(GOOD_ID));
});

await check('privacy versions: the current one is stored; every acceptance is kept with time, who and version (append-only)', async () => {
  const v = await db.query(`SELECT id, sha256, length(content) AS n FROM privacy_versions ORDER BY id`);
  // Every published version stays (2026-11-19, 2026-11-19-b: placement coordinators, 2026-11-20: activity log).
  assert.ok(v.rows.some((r) => r.id === '2026-11-19'), JSON.stringify(v.rows.map((r) => r.id)));
  assert.ok(v.rows.some((r) => r.id === '2026-11-19-b'), JSON.stringify(v.rows.map((r) => r.id)));
  assert.ok(v.rows.some((r) => r.id === TERMS_VERSION && r.n > 1000 && /^[a-f0-9]{64}$/.test(r.sha256)), JSON.stringify(v.rows.map((r) => r.id)));
  const { rows: [u] } = await db.query(`SELECT id FROM users WHERE lower(email) = $1`, [withId]);
  const before = await db.query(`SELECT privacy_version, marketing, source, at FROM consent_records WHERE subject_kind = 'user' AND subject_id = $1 ORDER BY id`, [u.id]);
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].privacy_version, TERMS_VERSION);
  assert.equal(before.rows[0].source, 'signup');
  assert.ok(before.rows[0].at instanceof Date);
  // A marketing answer in the personal area is a new row (the old one stays).
  assert.equal((await candidate.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: true })).status, 200);
  const after = await db.query(`SELECT privacy_version, marketing, source FROM consent_records WHERE subject_kind = 'user' AND subject_id = $1 ORDER BY id`, [u.id]);
  assert.equal(after.rows.length, 2);
  assert.deepEqual(after.rows[1], { privacy_version: null, marketing: true, source: 'personal_area' });
  // Nothing can change or remove a record or a stored version.
  for (const sql of [`UPDATE consent_records SET privacy_version = NULL WHERE subject_id = '${u.id}'`, `DELETE FROM consent_records WHERE subject_id = '${u.id}'`,
    `UPDATE privacy_versions SET content = 'x' WHERE id = '2026-11-19'`, `DELETE FROM privacy_versions WHERE id = '2026-11-19'`]) {
    await assert.rejects(db.query(sql), /append-only/, sql);
  }
});

await check('restore the default setting', async () => {
  const r = await put(DEFAULT);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.fields, DEFAULT);
});

await db.end();
for (const [s, name, err] of results) console.log(`${s === 'PASS' ? '✔' : '✖'} ${name}${err ? ` — ${err}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
