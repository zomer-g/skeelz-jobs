// Consent end to end (server/src/security/consent.ts): the required terms box, the optional marketing box, what is
// stored, withdrawal in the personal area, and the mailing-list gate observed for real.
// This script starts ITS OWN server (port CONSENT_PORT, default 3105) from dist/ with SMOOV switched on and pointed at
// a local mock (SMOOVE_API_URL is honoured only with DEV_MODE=true), so nothing leaves the machine.
//   cd server && npx tsc && DATABASE_URL=… node test/e2e-consent.mjs      (DATABASE_URL from server/.env by default)
// Local database only. Never point this at production.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { signUp, candidateLogin } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const PORT = Number(process.env.CONSENT_PORT || 3105);
const SMOOVE_PORT = Number(process.env.SMOOVE_MOCK_PORT || 3196);
const BASE = `http://localhost:${PORT}`;
if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing: DATABASE_URL must be a local database.');
  process.exit(1);
}
const { TERMS_VERSION } = await import('../dist/security/consent.js');
const stamp = Date.now();

// --- mock SMOOV: records the emails it was sent ---
const smooveSeen = [];
const smoove = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    smooveSeen.push({ method: req.method, text: decodeURIComponent(url.search) + ' ' + body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end('[]');
    res.end('{"id":1}');
  });
});
await new Promise((r) => smoove.listen(SMOOVE_PORT, '127.0.0.1', r));
const sentToSmoove = (email) => smooveSeen.some((s) => s.text.toLowerCase().includes(email.toLowerCase()));

// --- the server under test ---
const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.resolve(here, '..'),
  env: {
    ...process.env, PORT: String(PORT), XHOST_HTTP_PORT: String(PORT), DB_POOL_MAX: '2', DEV_MODE: 'true',
    ENABLE_SMOOVE: 'true', SMOOVE_API_KEY: 'e2e-not-a-key', SMOOVE_LIST_ID: '1', SMOOVE_GUEST_LIST_ID: '2',
    SMOOVE_API_URL: `http://127.0.0.1:${SMOOVE_PORT}/contacts`, ENABLE_SALESFORCE: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start')), 60_000);
  server.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); resolve(); } });
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

const jar = () => {
  const cookies = new Map();
  return {
    async req(method, p, body) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i); const v = kv.slice(i + 1);
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text };
    },
  };
};
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};
const settle = () => new Promise((r) => setTimeout(r, 300)); // sign-up / apply push to SMOOV before answering; margin

let n = 0;
const signupBody = (email, extra = {}) => ({
  firstName: 'Consent', lastName: 'Eee', email, phoneNumber: `05${String(stamp + ++n).slice(-8)}`,
  dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000,
  skills: [], hasAppliedToJob: false, ...extra,
});

try {
  // A job made on this site, open to quick applications: the existing site's jobs (a seeded local DB has only those)
  // take no applications here (409 job_on_existing_site, owner 23.11.2026).
  const jobId = `cc${Date.now().toString(16)}`.padEnd(24, '0').slice(0, 24);
  await db.query(`INSERT INTO jobs (id, title, company_name, publish_date, city_symbol, description, status, guest_mode_override)
                  VALUES ($1, 'Consent e2e', 'E2E', now() - interval '1 hour', 5000, '<p>e2e</p>', 'Active', 'quick')`, [jobId]);
  const jobs = await jar().req('GET', `/api/jobs/${jobId}`);
  assert.equal(jobs.json?.data?.onExistingSite, false, `the job to apply to: ${jobs.text.slice(0, 200)}`);

  // --- sign-up ---
  await check('sign-up without the terms box is refused, nothing created', async () => {
    const email = `consent-none-${stamp}@example.test`;
    for (const consent of [undefined, false, 'true']) {
      const r = await signUp(jar(), signupBody(email, consent === undefined ? {} : { consent }));
      assert.equal(r.status, 400, `${consent}: ${r.text}`);
      assert.equal(r.json.code, 'terms_required');
    }
    assert.equal(Number((await one('SELECT count(*) AS n FROM users WHERE lower(email) = $1', [email])).n), 0);
  });
  const noMk = `consent-nomk-${stamp}@example.test`;
  await check('marketing is optional: terms only → created, marketing = false, never sent to SMOOV', async () => {
    const r = await signUp(jar(), signupBody(noMk, { consent: true }));
    assert.equal(r.status, 200, r.text);
    await settle();
    const u = await one('SELECT terms_version, terms_accepted_at, marketing_consent, marketing_consent_at FROM users WHERE lower(email) = $1', [noMk]);
    assert.equal(u.terms_version, TERMS_VERSION);
    assert.ok(u.terms_accepted_at && u.marketing_consent_at);
    assert.equal(u.marketing_consent, false);
    assert.equal(sentToSmoove(noMk), false, 'a candidate without marketing consent reached SMOOV');
  });
  const yesMk = `consent-yes-${stamp}@example.test`;
  const cand = jar();
  let candId;
  await check('marketing ticked → stored true and sent to SMOOV', async () => {
    const r = await signUp(cand, signupBody(yesMk, { consent: true, marketingConsent: true }));
    assert.equal(r.status, 200, r.text);
    candId = r.json.data._id;
    await settle();
    assert.equal((await one('SELECT marketing_consent FROM users WHERE id = $1', [candId])).marketing_consent, true);
    assert.equal(sentToSmoove(yesMk), true, 'a candidate who agreed was not sent to SMOOV');
  });
  await check('marketing must be a boolean', async () => {
    const r = await signUp(jar(), signupBody(`consent-bad-${stamp}@example.test`, { consent: true, marketingConsent: 'yes' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'marketing_invalid');
  });

  // --- personal area: withdrawal ---
  await check('personal area shows the answers; withdrawal works and is logged', async () => {
    const me = await cand.req('GET', '/api/users/me');
    assert.equal(me.status, 200, me.text);
    assert.deepEqual({ t: me.json.data.consent.termsCurrent, m: me.json.data.consent.marketing }, { t: true, m: true });
    assert.equal((await cand.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: 'no' })).status, 400);
    const anon = await jar().req('PUT', '/api/users/me/marketing-consent', { marketingConsent: false });
    assert.ok(anon.status >= 400 && anon.status < 500, `anonymous: ${anon.status}`);
    const w = await cand.req('PUT', '/api/users/me/marketing-consent', { marketingConsent: false });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.data.consent.marketing, false);
    assert.equal((await one('SELECT marketing_consent FROM users WHERE id = $1', [candId])).marketing_consent, false);
    await settle();
    const a = await one(`SELECT actor, target, details FROM audit_log WHERE action = 'user.marketing_consent_changed' AND actor = $1 ORDER BY at DESC LIMIT 1`, [`user:${candId}`]);
    assert.ok(a, 'no audit entry');
    assert.equal(a.target, 'self');
    assert.deepEqual({ m: a.details.marketing, b: a.details.before }, { m: false, b: true });
    assert.ok(!JSON.stringify(a.details).includes('@'), 'personal data in the log');
  });

  // --- registered apply: asked once ---
  await check('registered apply: 428 until the current terms are accepted and marketing answered; then stored', async () => {
    await db.query('UPDATE users SET terms_version = NULL, terms_accepted_at = NULL, marketing_consent = NULL, marketing_consent_at = NULL WHERE id = $1', [candId]);
    const r1 = await cand.req('POST', `/api/jobs/apply/${jobId}`);
    assert.equal(r1.status, 428, r1.text);
    assert.deepEqual({ c: r1.json.code, t: r1.json.needTerms, m: r1.json.needMarketing }, { c: 'consent_needed', t: true, m: true });
    assert.equal((await cand.req('POST', `/api/jobs/apply/${jobId}`, { consent: true })).status, 428, 'marketing must be answered (yes or no)');
    assert.equal((await cand.req('POST', `/api/jobs/apply/${jobId}`, { marketingConsent: false })).status, 428, 'terms are required');
    const ok = await cand.req('POST', `/api/jobs/apply/${jobId}`, { consent: true, marketingConsent: false });
    assert.equal(ok.status, 200, ok.text);
    const u = await one('SELECT terms_version, marketing_consent FROM users WHERE id = $1', [candId]);
    assert.deepEqual({ t: u.terms_version, m: u.marketing_consent }, { t: TERMS_VERSION, m: false });
  });
  await check('registered apply: nothing asked once answered', async () => {
    const r = await cand.req('POST', `/api/jobs/apply/${jobId}`);
    assert.notEqual(r.status, 428, r.text); // already applied → a different refusal, but not consent
  });

  // --- the order: consent is asked and stored only once every other rule passed (owner, 23.11.2026) ---
  const resetConsent = () => db.query('UPDATE users SET terms_version = NULL, terms_accepted_at = NULL, marketing_consent = NULL, marketing_consent_at = NULL WHERE id = $1', [candId]);
  const consentRows = async () => Number((await one(`SELECT count(*) AS n FROM consent_records WHERE subject_kind = 'user' AND subject_id = $1`, [candId])).n);
  const cvJobId = `cd${Date.now().toString(16)}`.padEnd(24, '0').slice(0, 24);
  await db.query(`INSERT INTO jobs (id, title, company_name, publish_date, city_symbol, description, status, guest_mode_override, regular_cv_override)
                  VALUES ($1, 'Consent e2e CV required', 'E2E', now() - interval '1 hour', 5000, '<p>e2e</p>', 'Active', 'quick', 'required')`, [cvJobId]);
  await check('registered apply: a missing CV is reported before the consent question (400 jb11, not 428)', async () => {
    await resetConsent();
    const before = await consentRows();
    const r = await cand.req('POST', `/api/jobs/apply/${cvJobId}`, { cv: { mode: 'profile' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'jb11');
    // …and the answers sent with a refused application are not stored.
    const r2 = await cand.req('POST', `/api/jobs/apply/${cvJobId}`, { cv: { mode: 'profile' }, consent: true, marketingConsent: true });
    assert.equal(r2.json?.code, 'jb11', r2.text);
    const u = await one('SELECT terms_version, marketing_consent FROM users WHERE id = $1', [candId]);
    assert.deepEqual({ t: u.terms_version, m: u.marketing_consent }, { t: null, m: null });
    assert.equal(await consentRows(), before, 'a consent row was stored for a refused application');
  });
  await check('registered apply: already applied → 400 jb3 and no consent stored', async () => {
    const before = await consentRows();
    const r = await cand.req('POST', `/api/jobs/apply/${jobId}`, { consent: true, marketingConsent: true });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'jb3');
    assert.equal((await one('SELECT terms_version FROM users WHERE id = $1', [candId])).terms_version, null);
    assert.equal(await consentRows(), before);
  });

  // --- the consent step at sign-in (PUT /users/me/terms) ---
  await check('sign-in consent step: terms required; stored with a consent_records row (first_signin); logged without personal data', async () => {
    const me0 = await cand.req('GET', '/api/users/me');
    assert.deepEqual({ t: me0.json.data.consent.termsCurrent, m: me0.json.data.consent.marketing }, { t: false, m: null });
    const before = await consentRows();
    for (const body of [{}, { consent: false }, { consent: 'true' }]) {
      const r = await cand.req('PUT', '/api/users/me/terms', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.equal(r.json.code, 'terms_required');
    }
    assert.equal((await cand.req('PUT', '/api/users/me/terms', { consent: true, marketingConsent: 'yes' })).json?.code, 'marketing_invalid');
    assert.notEqual((await jar().req('PUT', '/api/users/me/terms', { consent: true })).status, 200, 'anonymous');
    assert.equal(await consentRows(), before, 'a refused answer was stored');
    const ok = await cand.req('PUT', '/api/users/me/terms', { consent: true, marketingConsent: true });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual({ t: ok.json.data.consent.termsCurrent, m: ok.json.data.consent.marketing }, { t: true, m: true });
    const u = await one('SELECT terms_version, marketing_consent, marketing_consent_source FROM users WHERE id = $1', [candId]);
    assert.deepEqual({ t: u.terms_version, m: u.marketing_consent, s: u.marketing_consent_source }, { t: TERMS_VERSION, m: true, s: 'first_signin' });
    const rec = await one(`SELECT privacy_version, marketing, source FROM consent_records WHERE subject_kind = 'user' AND subject_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [candId]);
    assert.deepEqual({ v: rec.privacy_version, m: rec.marketing, s: rec.source }, { v: TERMS_VERSION, m: true, s: 'first_signin' });
    assert.equal(await consentRows(), before + 1);
    await settle();
    const a = await one(`SELECT target, details FROM audit_log WHERE action = 'user.terms_accepted' AND actor = $1 ORDER BY at DESC LIMIT 1`, [`user:${candId}`]);
    assert.ok(a, 'no audit entry');
    assert.equal(a.target, 'self');
    assert.ok(!JSON.stringify(a.details).includes('@'), 'personal data in the log');
    // Again: nothing new to store.
    assert.equal((await cand.req('PUT', '/api/users/me/terms', { consent: true, marketingConsent: false })).status, 200);
    assert.equal(await consentRows(), before + 1, 'answered twice');
    assert.equal((await one('SELECT marketing_consent FROM users WHERE id = $1', [candId])).marketing_consent, true, 'the step changed an earlier marketing answer');
  });
  await check('sign-in consent step: an earlier marketing answer stays (only the terms are taken)', async () => {
    await db.query('UPDATE users SET terms_version = NULL, terms_accepted_at = NULL, marketing_consent = false WHERE id = $1', [candId]);
    const ok = await cand.req('PUT', '/api/users/me/terms', { consent: true, marketingConsent: true });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual({ t: ok.json.data.consent.termsCurrent, m: ok.json.data.consent.marketing }, { t: true, m: false });
    // Once accepted, applying asks nothing (the apply dialog is only the fallback).
    const r = await cand.req('POST', `/api/jobs/apply/${cvJobId}`, { cv: { mode: 'profile' } });
    assert.equal(r.json?.code, 'jb11', r.text);
  });

  // --- guest apply ---
  const guestApply = (email, extra) => jar().req('POST', '/api/jobs/guestApply', {
    jobData: { _id: jobId }, guestData: { fullName: 'Guest Consent', email, phoneNumber: '0504444444' }, ...extra,
  });
  await check('guest apply without the terms box is refused', async () => {
    const r = await guestApply(`guest-none-${stamp}@example.test`, {});
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'terms_required');
    assert.equal(Number((await one('SELECT count(*) AS n FROM guest_consents WHERE email = $1', [`guest-none-${stamp}@example.test`])).n), 0);
  });
  await check('guest: terms only → consent row (marketing false), not sent to SMOOV', async () => {
    const email = `guest-nomk-${stamp}@example.test`;
    const r = await guestApply(email, { consent: true });
    assert.equal(r.status, 200, r.text);
    await settle();
    const g = await one('SELECT job_id, terms_version, marketing_consent FROM guest_consents WHERE email = $1', [email]);
    assert.deepEqual({ j: g.job_id, t: g.terms_version, m: g.marketing_consent }, { j: jobId, t: TERMS_VERSION, m: false });
    assert.equal(sentToSmoove(email), false, 'a guest without marketing consent reached SMOOV');
  });
  await check('guest: marketing ticked → stored true and sent to SMOOV', async () => {
    const email = `guest-yes-${stamp}@example.test`;
    const r = await guestApply(email, { consent: true, marketingConsent: true });
    assert.equal(r.status, 200, r.text);
    await settle();
    assert.equal((await one('SELECT marketing_consent FROM guest_consents WHERE email = $1', [email])).marketing_consent, true);
    assert.equal(sentToSmoove(email), true);
  });

  await check('guest: the same address twice for the same job → the same answer as a new one, nothing stored the second time', async () => {
    const email = `guest-twice-${stamp}@example.test`;
    const first = await guestApply(email, { consent: true });
    assert.equal(first.status, 200);
    const again = await guestApply(email.toUpperCase(), { consent: true, marketingConsent: true });
    // Security review 24.11.2026, L6: nobody learns from the answer whether an address applied to a job.
    assert.equal(again.status, 200, again.text);
    assert.equal(again.text, first.text);
    assert.equal(Number((await one('SELECT count(*) AS n FROM guest_applications WHERE job_id = $1 AND email = $2', [jobId, email])).n), 1);
    assert.equal(Number((await one('SELECT count(*) AS n FROM guest_consents WHERE email = $1', [email])).n), 1);
  });

  // --- employer job form ---
  const skills = (await jar().req('GET', '/api/skills')).json.data.skills;
  const form = (title, extra = {}) => ({
    title, companyName: 'Consent Co', citySymbol: 9000, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
    description: 'תיאור משרה לבדיקת הסכמה, ארוך מספיק כדי לעבור את הבדיקה של הטופס.',
    contactName: 'איש קשר', contactEmail: `employer-${stamp}@example.test`, contactPhone: '0505555555', website: '', ...extra,
  });
  await check('employer form: terms required, marketing must be a boolean', async () => {
    const a = await jar().req('POST', '/api/job-submissions', form(`Consent A ${stamp}`));
    assert.equal(a.status, 400, a.text);
    assert.equal(a.json.fields.consent, 'required');
    const b = await jar().req('POST', '/api/job-submissions', form(`Consent B ${stamp}`, { consent: true, marketingConsent: 'x' }));
    assert.equal(b.status, 400, b.text);
    assert.equal(b.json.fields.marketingConsent, 'invalid');
  });
  await check('employer form: consent stored with the submission', async () => {
    const title = `Consent C ${stamp}`;
    const r = await jar().req('POST', '/api/job-submissions', form(title, { consent: true, marketingConsent: true }));
    assert.equal(r.status, 201, r.text);
    const s = await one('SELECT consent_at, terms_version, marketing_consent, marketing_consent_at FROM job_submissions WHERE title = $1', [title]);
    assert.ok(s.consent_at && s.marketing_consent_at);
    assert.deepEqual({ t: s.terms_version, m: s.marketing_consent }, { t: TERMS_VERSION, m: true });
  });
} finally {
  server.kill();
  smoove.close();
  await db.end();
}

for (const [s, name, msg] of results) console.log(`${s}  ${name}${msg ? `\n      ${msg}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
