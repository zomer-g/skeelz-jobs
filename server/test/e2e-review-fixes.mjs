// The privacy / security review of 24.11.2026 (HIGH + MEDIUM), against a running LOCAL server and its DB:
//   BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-review-fixes.mjs
// Server: server/.env.example + SANDBOX_EXPORT_TOKEN, RESEND_WEBHOOK_SECRET and SMOOV ON pointed at this suite's mock
// (values below; run-local.mjs passes them). Never a real SMOOV.
// H1  a huge "<<<…" added-field answer is refused at once (no quadratic regex), on the employer form and the personal area
// M1  a candidate who is also an employer: added answers saved, required ones asked; adding the candidate role checks them
// M2  SMOOV gets a quick applicant's "yes" only when the address was never removed; a removal unsubscribes in SMOOV
// M3  new removal rows carry the dedicated key; a row made with the old key still counts; boot re-key moves known ones
// M4  a webhook whose handling failed is handled on Resend's retry (same svix-id)
// M5  the sandbox export carries only the job fields shown on the job page
// Uses 1 of the per-IP employer-form submissions.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { staffLogin } from './helpers/staffLogin.mjs';
import { devCode, signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
export const SMOOVE_MOCK_PORT = 3197;
const SANDBOX_TOKEN = process.env.SANDBOX_EXPORT_TOKEN || 'e2e-sandbox-export-token-0123456789abcdef';
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || 'whsec_ZTJlLW1haWwtd2ViaG9vay1zZWNyZXQtMDEyMzQ1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const pg = (await import('pg')).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const { addressKey, addressKeys, legacyAddressKey } = await import('../dist/security/addressKey.js');

// ---- the mock SMOOV (records what the server sent; the addresses stay in this process) ----
const smoove = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    smoove.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    res.end(req.method === 'GET' ? '[]' : '{}');
  });
});
await new Promise((r) => mock.listen(SMOOVE_MOCK_PORT, '127.0.0.1', r));

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, headers = {}) {
      const h = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers };
      if (body && typeof body !== 'string') h['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers: h, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;
const addr = (w) => `review-${w}-${stamp}@example.test`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anon = jar(), cm = jar(), admin = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
let JOB_TEXT = '', JOB_HIDDEN = '', SIGNUP_REQ = '', jobId = '';

await check('setup: staff; a job text field (public) + a staff-only one; quick applications open', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200);
  const a = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'job', label: `ReDoS ${stamp}`.slice(0, 40), type: 'text', showOnJobPage: true });
  assert.equal(a.status, 201, a.text); JOB_TEXT = a.json.data.field.id;
  const b = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'job', label: `פנימי ${stamp}`.slice(0, 40), type: 'text' });
  assert.equal(b.status, 201, b.text); JOB_HIDDEN = b.json.data.field.id;
  assert.equal((await cm.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' })).status, 200);
  const job = await cm.req('POST', '/api/jobs', {
    title: `Review ${stamp}`.slice(0, 30), jobScope: ['FullTime'], companyName: 'Review', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: city.citySymbol, description: '<p>e2e review</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skills[0]._id],
    isSponsored: false, isMarked: false, customFields: { [JOB_TEXT]: 'שכר ציבורי', [JOB_HIDDEN]: `staff-note-${stamp}` },
  });
  assert.equal(job.status, 200, job.text); jobId = job.json.data.id;
});

await check('H1: a 1MB "<<<…" added-field answer is refused at once (employer form, personal area); the server stays up', async () => {
  const big = '<'.repeat(900_000);
  let t = Date.now();
  const r = await anon.req('POST', '/api/job-submissions', {
    title: `RD-${stamp}`.slice(0, 28), companyName: 'ReDoS', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
    description: `תיאור ארוך מספיק של משרה לבדיקת קלט ענק בשדה נוסף ${stamp}.`, externalLink: '', publicEmail: '',
    contactName: 'בודק', contactEmail: addr('redos'), contactPhone: '050-1234567', consent: true, website: '', customFields: { [JOB_TEXT]: big },
  });
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assert.ok(Date.now() - t < 3000, `answered in ${Date.now() - t} ms`);
  const c = jar();
  assert.equal((await signUp(c, { firstName: 'גדול', lastName: 'קלט', email: addr('big'), phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true })).status, 200);
  const s = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'signup', label: `טקסט ${stamp}`.slice(0, 40), type: 'text' });
  assert.equal((await admin.req('PATCH', `/api/admin/settings/custom-fields/${s.json.data.field.id}`, { active: true })).status, 200);
  t = Date.now();
  const p = await c.req('PATCH', '/api/users/me', { customFields: { [s.json.data.field.id]: big } });
  assert.equal(p.status, 400, p.text.slice(0, 200));
  assert.ok(Date.now() - t < 3000, `answered in ${Date.now() - t} ms`);
  assert.equal((await anon.req('GET', '/api/health-check')).status, 200);
  assert.equal((await cm.req('PATCH', `/api/admin/settings/custom-fields/${s.json.data.field.id}`, { active: false })).status, 200);
});

const both = jar();
const BOTH = addr('both');
let bothId = '';
await check('M1: an employer who adds the candidate role must answer the required sign-up question; answers saved; asked again when a new one comes', async () => {
  const f = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'signup', label: `חובה ${stamp}`.slice(0, 40), type: 'text', required: true });
  SIGNUP_REQ = f.json.data.field.id;
  assert.equal((await admin.req('PATCH', `/api/admin/settings/custom-fields/${SIGNUP_REQ}`, { active: true })).status, 200);
  const code = await devCode(both, BOTH);
  assert.equal((await both.req('POST', '/api/auth/email/verify', { email: BOTH, code })).json.data.status, 'signup');
  const e = await both.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'שני', lastName: 'תפקידים', companyName: `שניים ${stamp}`.slice(0, 40),
    phone: phone(), jobTitle: '', consent: true, marketingConsent: false });
  assert.equal(e.status, 200, e.text);
  bothId = e.json.data.user._id ?? e.json.data.user.id;
  const body = { firstName: 'שני', lastName: 'תפקידים', phoneNumber: phone(), dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other',
    citySymbol: city.citySymbol, skills: [], consent: true };
  const missing = await both.req('POST', '/api/users/me/roles/candidate', body);
  assert.equal(missing.status, 400, missing.text);
  assert.ok(missing.json.fields.includes(`customFields.${SIGNUP_REQ}`));
  const ok = await both.req('POST', '/api/users/me/roles/candidate', { ...body, customFields: { [SIGNUP_REQ]: 'תשובה ראשונה' } });
  assert.equal(ok.status, 200, ok.text);
  const row = (await db.query(`SELECT role, roles, custom_fields FROM users WHERE id = $1`, [bothId])).rows[0];
  assert.equal(row.role, 'employer', 'role (the highest) is not "user"');
  assert.equal(row.custom_fields[SIGNUP_REQ], 'תשובה ראשונה', 'saved for a candidate + employer');
  assert.equal((await both.req('PATCH', '/api/users/me', { customFields: { [SIGNUP_REQ]: 'שונתה' } })).status, 200);
  assert.equal((await db.query(`SELECT custom_fields FROM users WHERE id = $1`, [bothId])).rows[0].custom_fields[SIGNUP_REQ], 'שונתה',
    'a change in the personal area is kept (was dropped: role = \'user\')');
  const g = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'signup', label: `חובה2 ${stamp}`.slice(0, 40), type: 'text', required: true });
  assert.equal((await admin.req('PATCH', `/api/admin/settings/custom-fields/${g.json.data.field.id}`, { active: true })).status, 200);
  assert.equal((await both.req('GET', '/api/users/me')).json.data.profileIncomplete, true, 'asked to complete');
  for (const id of [SIGNUP_REQ, g.json.data.field.id]) await cm.req('PATCH', `/api/admin/settings/custom-fields/${id}`, { active: false });
});

const smooveCreates = (email) => smoove.filter((x) => x.method === 'POST' && !/Unsubscribe/.test(x.url) && x.body?.email === email);
const smooveUnsubs = (email) => smoove.filter((x) => x.method === 'POST' && x.url.includes(`/${encodeURIComponent(email)}/Unsubscribe`));
const quickApply = (email) => jar().req('POST', '/api/jobs/guestApply', {
  jobData: { _id: jobId }, guestData: { fullName: 'אורח', email, phoneNumber: phone() }, consent: true, marketingConsent: true,
});

await check('M2: SMOOV gets a quick applicant\'s "yes" only when the address was never removed; a removal unsubscribes there', async () => {
  const fresh = addr('fresh'), removed = addr('removed');
  assert.equal((await quickApply(fresh)).status, 200);
  await sleep(300);
  assert.equal(smooveCreates(fresh).length, 1, 'a never-removed "yes" reaches the list');
  const r = await cm.req('POST', '/api/admin/marketing/optouts', { email: removed });
  assert.equal(r.status, 200, r.text);
  await sleep(300);
  assert.equal(smooveUnsubs(removed).length, 1, 'the removal is sent to SMOOV');
  assert.equal((await quickApply(removed)).status, 200, 'the application itself is taken');
  await sleep(300);
  assert.equal(smooveCreates(removed).length, 0, 'an unverified "yes" never undoes a removal');
});

await check('M3: new rows carry the dedicated key; a row made with the old key still counts; the boot re-key moves known addresses', async () => {
  const removed = addr('removed');
  const row = (await db.query(`SELECT email_key FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [addressKeys(removed)])).rows[0];
  assert.equal(row.email_key, addressKey(removed), 'the new key (MARKETING_OPTOUT_SECRET)');
  assert.notEqual(addressKey(removed), legacyAddressKey(removed));
  // A removal made before the change (old key), of an address the site doesn't know: still honoured.
  const old = addr('old-removal');
  await db.query(`INSERT INTO marketing_optouts (email_key, via, actor) VALUES ($1, 'link', 'link:unsubscribe')`, [legacyAddressKey(old)]);
  assert.equal((await quickApply(old)).status, 200);
  await sleep(300);
  assert.equal(smooveCreates(old).length, 0, 'the old-key removal still wins');
  // Old-key rows of known addresses (here: the quick applicant just stored) move at boot.
  await db.query(`INSERT INTO mail_suppressions (email_key, reason) VALUES ($1, 'bounce') ON CONFLICT DO NOTHING`, [legacyAddressKey(old)]);
  process.env.MARKETING_OPTOUT_SECRET ||= 'dev-marketing-optout-secret-0123456789abcdef';
  const { rekeyAddressLists } = await import('../dist/services/addressKeyRekey.js');
  const moved = await rekeyAddressLists();
  assert.ok(moved && moved.moved.marketing_optouts >= 1 && moved.moved.mail_suppressions >= 1, JSON.stringify(moved));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM marketing_optouts WHERE email_key = $1`, [addressKey(old)])).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM marketing_optouts WHERE email_key = $1`, [legacyAddressKey(old)])).rows[0].n, 0);
  const again = await rekeyAddressLists();
  assert.deepEqual(again.moved, {}, 'idempotent');
  const log = (await db.query(`SELECT actor, details FROM audit_log WHERE action = 'mail.address_keys_moved' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(log.actor, 'system:migration');
  assert.ok(!JSON.stringify(log.details).includes('@'), 'counts only');
});

const sign = (id, ts, body) => `v1,${crypto.createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
const webhook = (event, id) => {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  return anon.req('POST', '/api/webhooks/resend', body, { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sign(id, ts, body) });
};
await check('M4: a complaint whose handling failed is handled on Resend\'s retry (same svix-id), not dropped as a duplicate', async () => {
  const to = addr('complaint');
  const id = `msg_${crypto.randomUUID()}`;
  const event = { type: 'email.complained', data: { email_id: `re_${stamp}`, to: [to] } };
  // Make the handling fail once: the suppression insert is refused by a temporary trigger.
  await db.query(`CREATE OR REPLACE FUNCTION e2e_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'e2e: handling fails'; END $$`);
  await db.query(`CREATE TRIGGER e2e_fail_once BEFORE INSERT ON mail_suppressions FOR EACH ROW EXECUTE FUNCTION e2e_fail_once()`);
  try {
    const first = await webhook(event, id);
    assert.equal(first.status, 500, first.text);
  } finally {
    await db.query(`DROP TRIGGER IF EXISTS e2e_fail_once ON mail_suppressions`);
  }
  const retry = await webhook(event, id);
  assert.equal(retry.status, 200, retry.text);
  assert.notEqual(retry.json?.data?.duplicate, true, 'not dropped as a duplicate');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM mail_suppressions WHERE email_key = ANY($1::text[])`, [addressKeys(to)])).rows[0].n, 1, 'suppressed');
  assert.ok((await db.query(`SELECT 1 FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [addressKeys(to)])).rowCount === 1, 'removed from marketing');
  const third = await webhook(event, id);
  assert.equal(third.json?.data?.duplicate, true, 'now a duplicate');
});

await check('M5: the sandbox export carries only the added job fields shown on the job page', async () => {
  const r = await anon.req('GET', '/api/internal/export', undefined, { Authorization: `Bearer ${SANDBOX_TOKEN}` });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const job = r.json.jobs.find((j) => j.id === jobId);
  assert.ok(job, 'the job is exported');
  assert.equal(job.custom_fields[JOB_TEXT], 'שכר ציבורי');
  assert.ok(!(JOB_HIDDEN in job.custom_fields), 'no staff-only answer');
  assert.ok(!r.text.includes(`staff-note-${stamp}`));
  for (const id of [JOB_TEXT, JOB_HIDDEN]) await cm.req('PATCH', `/api/admin/settings/custom-fields/${id}`, { active: false });
});

await db.end();
mock.close();
for (const [s, n, e] of results) console.log(`${s}  ${n}${e ? `  ${e}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
