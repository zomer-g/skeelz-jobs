// Fields content managers add on the settings screen → Salesforce (owner, 23.11.2026; docs/settings.md "Salesforce"),
// against a MOCK Salesforce (test/helpers/mockSalesforce.mjs) — never a real org. Same server setup as
// test/e2e-salesforce.mjs (Salesforce ON, pointed at the mock on 127.0.0.1:3198; fresh DB; restart the server first):
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://… node test/e2e-salesforce-fields.mjs
// Covers: only admins link (content managers see the state, coordinators nothing); names checked (custom __c only, never
// a field the site already writes, the Beta mark or one already linked); nothing is sent until the org has the field
// (describe, read-only), then the answer goes with the next update through the queue, on the candidate's Contact and
// the job's Position Case, with the Beta mark; unlinking stops it; the connection check names unlinked fields; the
// site never creates or deletes a field in Salesforce; the log has ids and API names, never an answer.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp } from './helpers/candidate.mjs';
import { startMockSalesforce, MOCK_IDS } from './helpers/mockSalesforce.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
if (!process.env.DATABASE_URL || !/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) throw new Error('DATABASE_URL of the LOCAL dev database is required');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const pg = (await import('pg')).default;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const sf = await startMockSalesforce({ port: Number(process.env.MOCK_SF_PORT || 3198) });

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
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
const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const phone = () => `05${Array.from(crypto.randomBytes(8), (b) => String(b % 10)).join('')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const syncRow = async (kind, id, until, ms = 15000) => {
  const end = Date.now() + ms;
  let row;
  while (Date.now() < end) {
    row = (await db.query(`SELECT *, queued_at IS NOT NULL AS queued FROM salesforce_sync WHERE kind = $1 AND record_id = $2`, [kind, id])).rows[0];
    if (row && until(row)) return row;
    await sleep(250);
  }
  throw new Error(`${kind} ${id}: sync row never reached the state (last: ${JSON.stringify(row && { code: row.last_error_code, queued: row.queued })})`);
};
/** Synced after `since` (a push that happened after a change). */
const syncedAfter = (since) => (r) => !!r.last_pushed_at && !r.queued && !r.last_error_code && new Date(r.last_pushed_at) > since;
const SECRET = `תשובה-${stamp}`;

const admin = jar(), cm = jar(), cand = jar();
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin');
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager');
const city = (await jar().req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const skillId = (await jar().req('GET', '/api/skills')).json.data.skills[0]._id;
const link = (id, sfField, c = admin) => c.req('PUT', `/api/admin/security/salesforce/custom-fields/${id}`, { sfField });
const statusOf = async (id) => (await cm.req('GET', '/api/admin/settings/custom-fields')).json.data.salesforce.status[id];
let SHIFT, SALARY, OTHER, candId, jobId;

await check('setup: Salesforce is on, pointed at the mock; content managers add a sign-up question and a job field (not linked)', async () => {
  const s = await admin.req('GET', '/api/admin/security/salesforce');
  assert.equal(s.json?.data?.enabled, true, 'start the server with the mock values (see test/e2e-salesforce.mjs)');
  const a = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'signup', label: 'משמרת', type: 'select', options: ['בוקר', 'ערב'] });
  assert.equal(a.status, 201, a.text); SHIFT = a.json.data.field.id;
  const b = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'job', label: 'שכר', type: 'text', showOnJobPage: true });
  assert.equal(b.status, 201, b.text); SALARY = b.json.data.field.id;
  const c = await cm.req('POST', '/api/admin/settings/custom-fields', { form: 'signup', label: 'הערה', type: 'text' });
  assert.equal(c.status, 201); OTHER = c.json.data.field.id;
  // A content manager's sign-up question is asked only once an admin turns it on (owner, 24.11.2026).
  for (const id of [SHIFT, OTHER]) assert.equal((await admin.req('PATCH', `/api/admin/settings/custom-fields/${id}`, { active: true })).status, 200);
  const list = (await cm.req('GET', '/api/admin/settings/custom-fields')).json.data;
  assert.equal(list.salesforce.enabled, true);
  assert.equal(list.salesforce.status[SHIFT], 'not_linked');
  assert.equal(list.fields.find((f) => f.id === SHIFT).sfField, null);
});

const refused = (r) => r.status === 401 || r.status === 403 || (r.status === 400 && /^(Forbidden|Unauthorized|au\d+)$/.test(String(r.json?.code ?? '')));
await check('linking is admin-only: a content manager is refused (and cannot set it through the settings PATCH either)', async () => {
  try {
    const r = await link(SHIFT, 'Shift__c', cm);
    assert.ok(refused(r) && !r.json?.data, `content manager: ${r.status} ${r.text}`);
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'signs in again');
    const p = await cm.req('PATCH', `/api/admin/settings/custom-fields/${SHIFT}`, { sfField: 'Shift__c' });
    assert.equal(p.json?.code, 'unknown_key');
    assert.ok(refused(await cm.req('GET', '/api/admin/security/salesforce/custom-fields')));
  } finally {
    assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'signs in again');
  }
  const { rows } = await db.query(`SELECT sf_field FROM custom_fields WHERE id = $1`, [SHIFT]);
  assert.equal(rows[0].sf_field, null);
});

await check('names: a custom __c field only, never one the site writes, the Beta mark or one already linked', async () => {
  for (const [name, code] of [['Email', 'sf_field_invalid'], ['Shift', 'sf_field_invalid'], ["x__c' OR 1=1", 'sf_field_invalid'],
    ['Beta__c', 'sf_field_reserved'], ['ID_Number__c', 'sf_field_reserved'], ['Threshold_Condition__c', 'sf_field_reserved'], ['CV_link_cambium__c', 'sf_field_reserved']]) {
    const r = await link(SHIFT, name);
    assert.equal(r.json?.code, code, `${name}: ${r.text}`);
  }
});

await check('linked to a field the org does not have: status "missing", nothing of it is sent (the Contact still goes)', async () => {
  const r = await link(SHIFT, 'Shift__c');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.salesforce.status[SHIFT], 'missing');
  assert.equal(await statusOf(SHIFT), 'missing');
  const writesBefore = sf.seen.writes.length;
  const since = new Date();
  const s = await signUp(cand, { firstName: 'שדה', lastName: 'סיילס', email: `sff-${stamp}@example.test`, phoneNumber: phone(),
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'female', citySymbol: city.citySymbol, skills: [skillId], consent: true,
    customFields: { [SHIFT]: 'ערב', [OTHER]: SECRET } });
  assert.equal(s.status, 200, s.text);
  candId = String(s.json.data._id);
  await syncRow('candidate', candId, syncedAfter(since));
  const c = [...sf.records.Contact.values()].find((x) => x.ID_cambium__c === candId);
  assert.ok(c, 'Contact made');
  assert.equal(c.Beta__c, true);
  assert.ok(!('Shift__c' in c), 'not sent while the org has no such field');
  assert.ok(!JSON.stringify(c).includes(SECRET), 'an unlinked field is never sent');
  assert.ok(sf.seen.writes.slice(writesBefore).every((w) => !w.fields.includes('Shift__c')));
});

await check('the owner creates the field; the admin links it again (the org is re-read): sent with the next update, Beta kept', async () => {
  sf.addFields('Contact', [{ name: 'Shift__c', type: 'picklist' }]);
  const r = await link(SHIFT, 'Shift__c');
  assert.equal(r.json.data.salesforce.status[SHIFT], 'ok', r.text);
  assert.equal(await statusOf(SHIFT), 'ok');
  const since = new Date();
  assert.equal((await cand.req('PATCH', '/api/users/me', { customFields: { [SHIFT]: 'בוקר' } })).status, 200);
  await syncRow('candidate', candId, syncedAfter(since));
  const contacts = [...sf.records.Contact.values()].filter((x) => x.ID_cambium__c === candId);
  assert.equal(contacts.length, 1, 'the same Contact');
  assert.equal(contacts[0].Shift__c, 'בוקר');
  assert.equal(contacts[0].Beta__c, true);
  assert.ok(!JSON.stringify(contacts[0]).includes(SECRET));
});

await check('a field of the wrong type is not sent; two fields cannot share one Salesforce field', async () => {
  sf.addFields('Contact', [{ name: 'Note_Flag__c', type: 'boolean' }]);
  const w = await link(OTHER, 'Note_Flag__c');
  assert.equal(w.json.data.salesforce.status[OTHER], 'wrong_type');
  const t = await link(OTHER, 'Shift__c');
  assert.equal(t.status, 409);
  assert.equal(t.json.code, 'sf_field_taken');
  assert.equal((await link(OTHER, null)).json.data.salesforce.status[OTHER], 'not_linked');
});

await check('job field → the job\'s Position Case (existing record type), once linked and in the org', async () => {
  sf.addFields('Case', [{ name: 'Salary__c', type: 'string' }]);
  assert.equal((await link(SALARY, 'Salary__c')).json.data.salesforce.status[SALARY], 'ok');
  const since = new Date();
  const j = await cm.req('POST', '/api/jobs', {
    title: `SF fields ${stamp}`.slice(0, 30), jobScope: ['FullTime'], companyName: 'SF Fields', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: city.citySymbol, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, customFields: { [SALARY]: '45 ₪' },
  });
  assert.equal(j.status, 200, j.text);
  jobId = j.json.data.id;
  await syncRow('job', jobId, syncedAfter(since));
  const c = [...sf.records.Case.values()].filter((x) => x.PID_cambium__c === jobId);
  assert.equal(c.length, 1);
  assert.equal(c[0].Salary__c, '45 ₪');
  assert.equal(c[0].RecordTypeId, MOCK_IDS.jobsRecordType, 'the existing Position record type');
  assert.equal(c[0].Beta__c, true);
  // Cleared on the site → cleared there.
  const since2 = new Date();
  assert.equal((await cm.req('PATCH', `/api/jobs/${jobId}`, { status: 'Active', customFields: { [SALARY]: '' } })).status, 200);
  await syncRow('job', jobId, syncedAfter(since2));
  assert.equal([...sf.records.Case.values()].find((x) => x.PID_cambium__c === jobId).Salary__c, null);
});

await check('unlinked or turned off → no longer sent', async () => {
  assert.equal((await link(SHIFT, null)).status, 200);
  const before = sf.seen.writes.length;
  const since = new Date();
  assert.equal((await cand.req('PATCH', '/api/users/me', { customFields: { [SHIFT]: 'ערב' } })).status, 200);
  await syncRow('candidate', candId, syncedAfter(since));
  assert.ok(sf.seen.writes.slice(before).filter((w) => w.object === 'Contact').every((w) => !w.fields.includes('Shift__c')));
  assert.equal([...sf.records.Contact.values()].find((x) => x.ID_cambium__c === candId).Shift__c, 'בוקר', 'left as it was there (never cleared by an unlink)');
});

await check('the connection check lists the added fields (a warning while one is not sent) and writes nothing', async () => {
  const before = sf.seen.writes.length;
  const r = await admin.req('POST', '/api/admin/security/salesforce/check', {});
  assert.equal(r.status, 200, r.text);
  const item = r.json.data.items.find((i) => i.id === 'custom_fields');
  assert.ok(item, 'custom_fields item');
  assert.equal(item.warn, true);
  assert.ok(item.detail.some((d) => d.includes(SALARY) && d.includes('in use')), JSON.stringify(item.detail));
  assert.ok(item.detail.some((d) => d.includes(SHIFT) && d.includes('not linked')), JSON.stringify(item.detail));
  assert.equal(sf.seen.writes.length, before);
  // The site never creates, changes or deletes a field in Salesforce (no metadata / tooling calls exist in the mock).
  assert.equal(sf.seen.deletes, 0);
});

await check('the activity log: links by field id and API name; an answer never', async () => {
  const rows = (await db.query(`SELECT target, details FROM audit_log WHERE action = 'salesforce.custom_field_linked' ORDER BY id`)).rows;
  assert.ok(rows.some((r) => r.target === `custom_field:${SHIFT}` && r.details.sf_field === 'Shift__c' && r.details.object === 'Contact'));
  assert.ok(rows.some((r) => r.target === `custom_field:${SALARY}` && r.details.object === 'Case'));
  const leak = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%' || $1 || '%' OR details::text LIKE '%45 ₪%'`, [SECRET]);
  assert.equal(leak.rows[0].n, 0);
});

await check('clean-up: the fields this run added are turned off; the job archived', async () => {
  for (const id of [SHIFT, SALARY, OTHER]) assert.equal((await cm.req('PATCH', `/api/admin/settings/custom-fields/${id}`, { active: false })).status, 200);
  if (jobId) assert.equal((await cm.req('POST', `/api/admin/jobs/${jobId}/archive`)).status, 200);
});

await db.end();
await sf.close?.();
for (const [s, name, err] of results) console.log(`${s === 'PASS' ? '✔' : '✖'} ${name}${err ? ` — ${err}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
