// The settings screen (/settings) and the fields content managers add to the sign-up form and the job form
// (docs/settings.md), end to end against a running LOCAL server (DEV_MODE=true, the mock SSO values from
// server/.env.example; a fresh DB is best; restart the server first — it spends sign-ups and per-IP writes):
//   BASE=http://localhost:3100 DATABASE_URL=postgresql://... node test/e2e-settings.mjs
// Checks: only content managers and admins define fields (coordinators, employers, candidates and anonymous refused);
// the public sign-up form gets definitions only; the server enforces required answers on sign-up, in the personal
// area and on a new job; answers are saved and shown (staff list through peopleHandover; the job page only for fields
// marked so); never on the default user object, the public API or to employers; a field is turned off, never deleted;
// the activity log has ids and field names, never an answer. Turns every field it added off at the end.
// Never point this at production.
import assert from 'node:assert/strict';
import pg from 'pg';
import { staffLogin } from './helpers/staffLogin.mjs';
import { candidateLogin, devCode, signUp } from './helpers/candidate.mjs';
(await import('dotenv')).config();

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@example.test').toLowerCase();
const CM_EMAIL = (process.env.CM_EMAIL || process.env.CONTENT_MANAGER_EMAIL || 'content@example.test').toLowerCase();

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    clear: () => cookies.clear(),
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
const addr = (k) => `set-${k}-${stamp}@example.test`;
const settle = () => new Promise((r) => setTimeout(r, 400)); // fire-and-forget log writes
let n = 0;
const phone = () => `05${String(stamp + (++n)).slice(-8)}`;
const details = (extra = {}) => ({
  firstName: 'הגדרות', lastName: 'בדיקה', phoneNumber: phone(), citySymbol: 5000, gender: 'female',
  dateOfBirth: '1991-02-03T12:00:00.000Z', skills: [], consent: true, ...extra,
});
// Answers that must never reach the log, the public or an employer.
const SECRET = `תשובה-סודית-${stamp}`;
const JOB_PRIVATE = `פנימי-${stamp}`;
const JOB_PUBLIC = `שכר שעתי ${stamp % 1000} ₪`;

const admin = jar();
const cm = jar();
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'setup: admin signs in');
assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'setup: content manager signs in');
const create = (body, c = cm) => c.req('POST', '/api/admin/settings/custom-fields', body);
const patch = (id, body, c = cm) => c.req('PATCH', `/api/admin/settings/custom-fields/${id}`, body);
const added = []; // turned off at the end

// A placement coordinator (invited by the admin, Google sign-in).
const CO_EMAIL = addr('coordinator');
const co = jar();
assert.equal((await admin.req('POST', '/api/admin/staff', { email: CO_EMAIL, role: 'placement_coordinator', firstName: 'רכזת', lastName: 'הגדרות' })).status, 200, 'setup: coordinator invited');
assert.equal((await staffLogin(co, CO_EMAIL)).status, 200, 'setup: coordinator signs in');
// An employer (sign-up by email code).
const emp = jar();
const EMP_EMAIL = addr('employer');
{
  const code = await devCode(emp, EMP_EMAIL);
  await emp.req('POST', '/api/auth/email/verify', { email: EMP_EMAIL, code });
  const r = await emp.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה הגדרות', phone: phone(), jobTitle: 'מגייסת', consent: true });
  assert.equal(r.status, 200, `setup: employer sign-up ${r.text}`);
}
const skills = (await jar().req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;

let REQ_TEXT, OPT_SELECT, OPT_CHECK, JOB_REQ, JOB_HIDDEN;

await check('only content managers and admins define fields: anonymous, a candidate, a coordinator and an employer are refused', async () => {
  const cand = jar();
  assert.equal((await signUp(cand, { ...details(), email: addr('early') })).status, 200, 'candidate');
  const body = { form: 'signup', label: 'לא אמור להיווצר', type: 'text' };
  for (const [who, c] of [['anonymous', jar()], ['candidate', cand], ['coordinator', co], ['employer', emp]]) {
    for (const [m, p, b] of [['GET', '/api/admin/settings/custom-fields'], ['POST', '/api/admin/settings/custom-fields', body],
      ['PATCH', '/api/admin/settings/custom-fields/000000000000000000000000', { active: false }],
      ['PUT', '/api/admin/settings/signup-fields', { idNumber: 'optional' }], ['PUT', '/api/admin/settings/apply-policy', { quickCv: 'optional' }],
      ['GET', '/api/admin/settings/employer-posting']]) {
      const r = await c.req(m, p, b);
      assert.ok(r.status >= 400 && r.status < 404 && !r.json?.data, `${who} ${m} ${p}: ${r.status}`);
    }
    if (who === 'coordinator') { assert.equal((await staffLogin(co, CO_EMAIL)).status, 200, 'coordinator signs in again'); }
  }
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM custom_fields WHERE label = 'לא אמור להיווצר'`);
  assert.equal(rows[0].n, 0);
  // The job form's definitions: everyone who edits jobs (coordinators too), never an employer or a candidate.
  assert.equal((await co.req('GET', '/api/admin/job-fields')).status, 200, 'coordinator reads the job form fields');
  { const r = await emp.req('GET', '/api/admin/job-fields'); assert.ok(r.status >= 400 && r.status < 404 && !r.json?.data, `employer refused: ${r.status}`); }
  { const r = await jar().req('GET', '/api/admin/job-fields'); assert.ok(r.status >= 400 && r.status < 404 && !r.json?.data, `anonymous refused: ${r.status}`); }
});

await check('bad definitions refused with a code (label, options, unknown key, type, public sign-up field, unknown form)', async () => {
  for (const [body, code] of [
    [{ form: 'signup', label: 'א', type: 'text' }, 'bad_label'],
    [{ form: 'signup', label: 'משמרת', type: 'select', options: ['בוקר'] }, 'bad_options'],
    [{ form: 'signup', label: 'משמרת', type: 'select', options: ['בוקר', 'בוקר'] }, 'bad_options'],
    [{ form: 'signup', label: 'שאלה', type: 'date' }, 'bad_type'],
    [{ form: 'signup', label: 'שאלה', type: 'text', value: 'x' }, 'unknown_key'],
    [{ form: 'signup', label: 'שאלה', type: 'text', showOnJobPage: true }, 'bad_value'],
    [{ form: 'users', label: 'שאלה', type: 'text' }, 'bad_form'],
  ]) {
    const r = await create(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, code, JSON.stringify(body));
  }
});

await check('a content manager adds sign-up questions (text required, list, checkbox) — asked only once an ADMIN turns them on; the admin own ones at once; the public form gets definitions only', async () => {
  const a = await create({ form: 'signup', label: 'מאיפה שמעת עלינו?', type: 'text', required: true, help: 'במילים שלך' });
  assert.equal(a.status, 201, a.text);
  REQ_TEXT = a.json.data.field.id; added.push(REQ_TEXT);
  const b = await create({ form: 'signup', label: 'משמרת מועדפת', type: 'select', options: ['בוקר', 'ערב', 'לילה'] });
  assert.equal(b.status, 201, b.text);
  OPT_SELECT = b.json.data.field.id; added.push(OPT_SELECT);
  // Owner, 24.11.2026 (security review M6): a content manager's sign-up question waits for an admin.
  assert.equal(a.json.data.awaitingAdmin, true);
  assert.equal(a.json.data.field.active, false);
  assert.ok(!(await jar().req('GET', '/api/custom-fields/signup')).json.data.fields.some((f) => f.id === REQ_TEXT), 'not asked yet');
  const self = await patch(REQ_TEXT, { active: true });
  assert.equal(self.status, 403, self.text);
  assert.equal(self.json.code, 'admin_approval_required');
  for (const id of [REQ_TEXT, OPT_SELECT]) assert.equal((await patch(id, { active: true }, admin)).status, 200, 'the admin approves');
  const c = await create({ form: 'signup', label: 'יש לי רישיון נהיגה', type: 'checkbox' }, admin);
  assert.equal(c.status, 201, c.text);
  OPT_CHECK = c.json.data.field.id; added.push(OPT_CHECK);
  const pub = await jar().req('GET', '/api/custom-fields/signup');
  assert.equal(pub.status, 200);
  const mine = pub.json.data.fields.filter((f) => added.includes(f.id));
  assert.deepEqual(mine.map((f) => f.id), [REQ_TEXT, OPT_SELECT, OPT_CHECK], 'in order');
  assert.deepEqual(Object.keys(mine[0]).sort(), ['help', 'id', 'label', 'options', 'required', 'type']);
  assert.deepEqual(mine[1].options, ['בוקר', 'ערב', 'לילה']);
  const list = (await cm.req('GET', '/api/admin/settings/custom-fields')).json.data.fields;
  assert.ok(list.find((f) => f.id === REQ_TEXT)?.active === true);
  assert.ok(list.find((f) => f.id === REQ_TEXT)?.approvedAt, 'approval recorded');
  const ap = await db.query(`SELECT actor FROM audit_log WHERE action = 'settings.custom_field_approved' AND target = $1`, [`custom_field:${REQ_TEXT}`]);
  assert.equal(ap.rows[0]?.actor, ADMIN_EMAIL);
  // A content manager's rewording turns it off until an admin approves the new wording.
  const re = await patch(OPT_SELECT, { label: 'משמרת מועדפת (מעודכן)' });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.json.data.awaitingAdmin, true);
  assert.equal(re.json.data.field.active, false);
  assert.equal((await patch(OPT_SELECT, { label: 'משמרת מועדפת', active: true }, admin)).status, 200);
});

const cand = jar();
const CAND = addr('answers');
let candId;
await check('sign-up: the server refuses a missing required answer and an option not on the list; nothing is created', async () => {
  const a = await signUp(jar(), { ...details(), email: addr('noanswer') });
  assert.equal(a.status, 400);
  assert.ok(a.json.fields.includes(`customFields.${REQ_TEXT}`), a.text);
  const b = await signUp(jar(), { ...details(), email: addr('badoption'), customFields: { [REQ_TEXT]: 'חבר', [OPT_SELECT]: 'צהריים' } });
  assert.equal(b.status, 400);
  assert.deepEqual(b.json.fields, [`customFields.${OPT_SELECT}`]);
  const c = await signUp(jar(), { ...details(), email: addr('blank'), customFields: { [REQ_TEXT]: '   ' } });
  assert.equal(c.status, 400, 'blank is no answer');
  const { rows } = await db.query(`SELECT 1 FROM users WHERE lower(email) = ANY($1)`, [[addr('noanswer'), addr('badoption'), addr('blank')]]);
  assert.equal(rows.length, 0);
});

await check('sign-up with answers: saved by field id (unknown keys dropped); not on the sign-in answer; shown in the personal area', async () => {
  const r = await signUp(cand, { ...details(), email: CAND, customFields: { [REQ_TEXT]: SECRET, [OPT_SELECT]: 'ערב', [OPT_CHECK]: true, evil: 'x' } });
  assert.equal(r.status, 200, r.text);
  candId = r.json.data._id;
  assert.ok(!('customFields' in r.json.data.user), 'the sign-in answer carries no answers');
  const { rows } = await db.query(`SELECT custom_fields FROM users WHERE id = $1`, [candId]);
  assert.deepEqual(rows[0].custom_fields, { [REQ_TEXT]: SECRET, [OPT_SELECT]: 'ערב', [OPT_CHECK]: true });
  const s = await cand.req('GET', '/api/auth/session');
  assert.ok(!s.text.includes(SECRET), 'session carries no answers');
  const me = await cand.req('GET', '/api/users/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.data.user.customFields, rows[0].custom_fields);
  assert.equal(me.json.data.profileIncomplete, false);
});

await check('personal area: a required answer is not cleared, an optional one is, a wrong option refused', async () => {
  const a = await cand.req('PATCH', '/api/users/me', { customFields: { [REQ_TEXT]: '' } });
  assert.equal(a.status, 400);
  assert.deepEqual(a.json.fields, [`customFields.${REQ_TEXT}`]);
  const b = await cand.req('PATCH', '/api/users/me', { customFields: { [OPT_SELECT]: 'צהריים' } });
  assert.equal(b.status, 400);
  const c = await cand.req('PATCH', '/api/users/me', { customFields: { [OPT_SELECT]: '', [OPT_CHECK]: false } });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json.data.user.customFields, { [REQ_TEXT]: SECRET });
  const d = await cand.req('PATCH', '/api/users/me', { customFields: { [OPT_SELECT]: 'בוקר' } });
  assert.equal(d.status, 200);
  assert.equal(d.json.data.user.customFields[OPT_SELECT], 'בוקר');
});

await check('staff see the answers only in the candidates list, with labels, through the hand-over (strict log with ids)', async () => {
  const r = await cm.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(CAND)}&usersFilter[limit]=9`);
  assert.equal(r.status, 200, r.text);
  const u = r.json.data.users.find((x) => x.email === CAND);
  assert.ok(u, 'listed');
  assert.deepEqual(u.extraDetails.map((x) => [x.label, x.value]), [['מאיפה שמעת עלינו?', SECRET], ['משמרת מועדפת', 'בוקר']]);
  assert.ok(!('customFields' in u), 'labels, not the raw map');
  await settle();
  const { rows } = await db.query(`SELECT details FROM audit_log WHERE action = 'candidates.shown' ORDER BY id DESC LIMIT 1`);
  assert.ok(JSON.stringify(rows[0].details).includes(String(candId)), 'shown ids logged before the data left');
  // A coordinator views candidates too (same hand-over).
  const c = await co.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(CAND)}&usersFilter[limit]=9`);
  assert.equal(c.status, 200);
  assert.equal(c.json.data.users.find((x) => x.email === CAND)?.extraDetails?.length, 2);
});

await check('a new required question asks existing candidates to complete their details; answering clears it', async () => {
  const r = await create({ form: 'signup', label: 'שאלה חדשה', type: 'text', required: true });
  assert.equal(r.status, 201);
  const id = r.json.data.field.id; added.push(id);
  assert.equal((await cand.req('GET', '/api/users/me')).json.data.profileIncomplete, false, 'not asked before an admin approves');
  assert.equal((await patch(id, { active: true }, admin)).status, 200);
  assert.equal((await cand.req('GET', '/api/users/me')).json.data.profileIncomplete, true);
  assert.equal((await cand.req('PATCH', '/api/users/me', { customFields: { [id]: 'עכשיו עניתי' } })).status, 200);
  assert.equal((await cand.req('GET', '/api/users/me')).json.data.profileIncomplete, false);
  // Turning it off asks nothing (and removes it from the public form).
  assert.equal((await patch(id, { active: false })).status, 200);
});

await check('turned off, never deleted: not asked, not accepted, the answer kept and still shown to staff; the type is fixed', async () => {
  assert.equal((await patch(OPT_SELECT, { type: 'text' })).json?.code, 'type_fixed');
  const off = await patch(OPT_SELECT, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.data.field.active, false);
  const pub = (await jar().req('GET', '/api/custom-fields/signup')).json.data.fields;
  assert.ok(!pub.some((f) => f.id === OPT_SELECT), 'not on the form');
  assert.equal((await cand.req('PATCH', '/api/users/me', { customFields: { [OPT_SELECT]: 'ערב' } })).status, 200);
  const { rows } = await db.query(`SELECT custom_fields FROM users WHERE id = $1`, [candId]);
  assert.equal(rows[0].custom_fields[OPT_SELECT], 'בוקר', 'an answer to a field that is off is not accepted, the old one kept');
  const list = (await cm.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(CAND)}&usersFilter[limit]=9`)).json.data.users;
  assert.deepEqual(list.find((x) => x.email === CAND).extraDetails.find((x) => x.id === OPT_SELECT), { id: OPT_SELECT, label: 'משמרת מועדפת', value: 'בוקר', active: false });
  await assert.rejects(db.query(`DELETE FROM custom_fields WHERE id = $1`, [OPT_SELECT]), /never deleted/);
  // Back on is an admin's (owner, 24.11.2026): the content manager is refused.
  assert.equal((await patch(OPT_SELECT, { active: true })).json?.code, 'admin_approval_required');
  assert.equal((await patch(OPT_SELECT, { active: true, label: 'משמרת' }, admin)).status, 200, 'back on, renamed');
});

let JOB;
await check('job fields: required enforced on a new job; answers saved; staff get them all; the job page, public API and MCP only the public one', async () => {
  const a = await create({ form: 'job', label: 'שכר', type: 'text', required: true, showOnJobPage: true });
  assert.equal(a.status, 201, a.text);
  JOB_REQ = a.json.data.field.id; added.push(JOB_REQ);
  const b = await create({ form: 'job', label: 'הערה פנימית', type: 'text' });
  assert.equal(b.status, 201);
  JOB_HIDDEN = b.json.data.field.id; added.push(JOB_HIDDEN);
  const defs = (await co.req('GET', '/api/admin/job-fields')).json.data.fields.map((f) => f.id);
  assert.ok(defs.includes(JOB_REQ) && defs.includes(JOB_HIDDEN));
  const job = (extra) => cm.req('POST', '/api/jobs', {
    title: `E2E Settings ${stamp}`.slice(0, 30), jobScope: ['FullTime'], companyName: 'E2E Settings', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, contactPersonEmail: `jobs-${stamp}@employer.test`, ...extra,
  });
  const no = await job({});
  assert.equal(no.status, 400);
  assert.equal(no.json.code, 'custom_fields_invalid');
  assert.deepEqual(no.json.fields, [`customFields.${JOB_REQ}`]);
  const ok = await job({ customFields: { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE } });
  assert.equal(ok.status, 200, ok.text);
  JOB = ok.json.data.id;
  const pub = await jar().req('GET', `/api/jobs/${JOB}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json.data.extraFields, [{ label: 'שכר', value: JOB_PUBLIC }]);
  assert.ok(!('customFields' in pub.json.data) && !pub.text.includes(JOB_PRIVATE), 'the private field never public');
  const board = await jar().req('GET', '/api/jobs/active');
  assert.ok(!board.text.includes(JOB_PRIVATE));
  const staff = (await cm.req('GET', '/api/admin/jobs/with-comments')).json.data.jobs.find((j) => j._id === JOB);
  assert.deepEqual(staff.customFields, { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE });
  // Owner, 23.11.2026: the public API and MCP carry the job fields shown on the job page (label + value), nothing else.
  const api = await jar().req('GET', `/api/public/v1/jobs/${JOB}`);
  assert.equal(api.status, 200, api.text);
  assert.deepEqual(api.json.data.extraFields, [{ label: 'שכר', value: JOB_PUBLIC }]);
  assert.ok(!api.text.includes(JOB_PRIVATE), 'a staff-only field never in the public API');
  const mcp = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_job', arguments: { id: JOB } } }) });
  const mcpText = await mcp.text();
  assert.ok(mcpText.includes(JOB_PUBLIC) && !mcpText.includes(JOB_PRIVATE), `MCP get_job: ${mcpText.slice(0, 200)}`);
  const { rows } = await db.query(`SELECT custom_fields FROM jobs WHERE id = $1`, [JOB]);
  assert.deepEqual(rows[0].custom_fields, { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE });
});

await check('a coordinator fills job fields on an edit (job content), but a required one is not cleared', async () => {
  const r = await co.req('PATCH', `/api/jobs/${JOB}`, { status: 'Active', customFields: { [JOB_HIDDEN]: 'רכזת עדכנה' } });
  assert.equal(r.status, 200, r.text);
  const c = await co.req('PATCH', `/api/jobs/${JOB}`, { status: 'Active', customFields: { [JOB_REQ]: '' } });
  assert.equal(c.status, 400);
  const { rows } = await db.query(`SELECT custom_fields FROM jobs WHERE id = $1`, [JOB]);
  assert.deepEqual(rows[0].custom_fields, { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: 'רכזת עדכנה' });
  // A field marked "show on the job page" stops showing when it is turned off.
  assert.equal((await patch(JOB_REQ, { showOnJobPage: false })).status, 200);
  assert.equal((await jar().req('GET', `/api/jobs/${JOB}`)).json.data.extraFields, undefined);
  assert.equal((await patch(JOB_REQ, { showOnJobPage: true })).status, 200);
});

await check('employers never get an answer: their area, their session and the job page carry none of the private ones', async () => {
  emp.clear(); // signed out by the refused staff routes above; sign in again
  assert.equal((await candidateLogin(emp, EMP_EMAIL)).status, 200, 'employer signs in again');
  assert.equal((await emp.req('GET', '/api/employer/me')).status, 200, 'employer area open');
  for (const p of ['/api/employer/me', '/api/employer/jobs', '/api/employer/applicants', '/api/auth/session', `/api/jobs/${JOB}`]) {
    const r = await emp.req('GET', p);
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(JOB_PRIVATE), `${p} leaks an answer`);
  }
  { const r = await emp.req('GET', `/api/users?usersFilter[limit]=9`); assert.ok(r.status >= 400 && r.status < 404 && !r.json?.data, `employer refused on the candidates list: ${r.status}`); }
});

await check('the activity log: definitions by id and key names; answers never; candidates and jobs by field names', async () => {
  await settle();
  const created = await db.query(`SELECT target, details FROM audit_log WHERE action = 'settings.custom_field_created' AND target = ANY($1)`, [added.map((id) => `custom_field:${id}`)]);
  assert.equal(created.rows.length, added.length);
  assert.ok(created.rows.every((r) => ['signup', 'job'].includes(r.details.form) && typeof r.details.label === 'string'));
  const upd = await db.query(`SELECT details FROM audit_log WHERE action = 'settings.custom_field_updated' AND target = $1 ORDER BY id`, [`custom_field:${OPT_SELECT}`]);
  // approved (admin) · reworded by the content manager (off again) · re-approved · off · back on renamed (admin)
  assert.deepEqual(upd.rows.map((r) => r.details.changed), [['active'], ['label', 'active'], ['label', 'active'], ['active'], ['label', 'active']]);
  const leak = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%' || $1 || '%' OR details::text LIKE '%' || $2 || '%' OR details::text LIKE '%' || $3 || '%'`,
    [SECRET, JOB_PRIVATE, JOB_PUBLIC]);
  assert.equal(leak.rows[0].n, 0, 'an answer is in the activity log');
  const prof = await db.query(`SELECT details FROM audit_log WHERE action = 'user.profile_updated' ORDER BY id DESC LIMIT 30`);
  assert.ok(prof.rows.some((r) => JSON.stringify(r.details.fields) === JSON.stringify([`customFields.${OPT_SELECT}`, `customFields.${OPT_CHECK}`])), JSON.stringify(prof.rows.map((r) => r.details)));
  const signup = await db.query(`SELECT details FROM audit_log WHERE action = 'auth.email_code_signup' AND target = $1`, [String(candId)]);
  assert.deepEqual(signup.rows[0].details.custom_fields, [REQ_TEXT, OPT_SELECT, OPT_CHECK]);
  const job = await db.query(`SELECT details FROM audit_log WHERE action = 'job.created' AND target = $1`, [JOB]);
  assert.ok(job.rows[0].details.fields.includes(`customFields.${JOB_REQ}`));
});


// ---- employer form and edit requests (owner, 23.11.2026) ----
let EMP_JOB;
await check('employer form: the job form fields come from the public list (definitions only); a required one is enforced; answers kept until approval, then on the job', async () => {
  emp.clear();
  assert.equal((await candidateLogin(emp, EMP_EMAIL)).status, 200, 'employer signs in');
  const pub = await jar().req('GET', '/api/custom-fields/job');
  assert.equal(pub.status, 200);
  const mine = pub.json.data.fields.filter((f) => [JOB_REQ, JOB_HIDDEN].includes(f.id));
  assert.equal(mine.length, 2);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['help', 'id', 'label', 'options', 'required', 'showOnJobPage', 'type']);
  const form = (extra) => emp.req('POST', '/api/job-submissions', {
    title: `טופס ${stamp % 100000}`, companyName: 'אקמה הגדרות', citySymbol: 5000, jobScope: ['FullTime'], requiredSkills: [skillId],
    description: 'משרה לבדיקת השדות שנוספו בטופס המעסיקים, עם מספיק טקסט.', contactName: 'דנה מעסיקה', contactEmail: EMP_EMAIL,
    contactPhone: '0501234567', consent: true, ...extra,
  });
  const no = await form({ customFields: { [JOB_HIDDEN]: 'x' } });
  assert.equal(no.status, 400, no.text);
  assert.equal(no.json.fields[`customFields.${JOB_REQ}`], 'required');
  const ok = await form({ customFields: { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE, evil: 'x' } });
  assert.equal(ok.status, 201, ok.text);
  const { rows: [sub] } = await db.query(`SELECT id, custom_fields FROM job_submissions WHERE contact_email = $1 ORDER BY created_at DESC LIMIT 1`, [EMP_EMAIL]);
  assert.deepEqual(sub.custom_fields, { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE });
  const open = await cm.req('GET', `/api/admin/job-submissions/${sub.id}`);
  assert.deepEqual(open.json.data.extraFields.map((x) => x.label), ['שכר', 'הערה פנימית'], 'staff see them with labels');
  const ap = await cm.req('POST', `/api/admin/job-submissions/${sub.id}/approve`, {});
  assert.equal(ap.status, 200, ap.text);
  EMP_JOB = ap.json.data.jobId;
  const { rows: [j] } = await db.query(`SELECT custom_fields FROM jobs WHERE id = $1`, [EMP_JOB]);
  assert.deepEqual(j.custom_fields, { [JOB_REQ]: JOB_PUBLIC, [JOB_HIDDEN]: JOB_PRIVATE });
});

await check('edit request: only the fields shown on the job page, their answers only; pending until staff approve; then the job changes', async () => {
  const one = await emp.req('GET', `/api/employer/jobs/${EMP_JOB}`);
  assert.equal(one.status, 200, one.text);
  assert.deepEqual(one.json.data.values.customFields, { [JOB_REQ]: JOB_PUBLIC }, 'a staff-only answer is never shown back to the employer');
  const clear = await emp.req('POST', `/api/employer/jobs/${EMP_JOB}/edit-requests`, { customFields: { [JOB_REQ]: '' } });
  assert.equal(clear.status, 400, 'a required one is not cleared');
  const req = await emp.req('POST', `/api/employer/jobs/${EMP_JOB}/edit-requests`, { customFields: { [JOB_REQ]: 'שכר חדש', [JOB_HIDDEN]: 'employer tries' } });
  assert.equal(req.status, 201, req.text);
  // Owner, 24.11.2026: every field — a staff-only one too, write-only for the employer (never shown back, never compared).
  assert.deepEqual([...req.json.data.fields].sort(), [`customFields.${JOB_HIDDEN}`, `customFields.${JOB_REQ}`].sort());
  assert.ok(!(await emp.req('GET', '/api/employer/edit-requests')).text.includes(JOB_PRIVATE), 'the stored staff-only answer is never in the employer list');
  assert.equal((await jar().req('GET', `/api/jobs/${EMP_JOB}`)).json.data.extraFields[0].value, JOB_PUBLIC, 'the live job is unchanged while pending');
  const view = await cm.req('GET', `/api/admin/job-edit-requests/${req.json.data.id}`);
  const row = view.json.data.comparison.find((c) => c.field === `customFields.${JOB_REQ}`);
  assert.deepEqual({ label: row.label, base: row.base, requested: row.requested }, { label: 'שכר', base: JOB_PUBLIC, requested: 'שכר חדש' });
  const ap = await co.req('POST', `/api/admin/job-edit-requests/${req.json.data.id}/approve`, {});
  assert.equal(ap.status, 200, `a coordinator approves an added-field change: ${ap.text}`);
  const { rows: [j] } = await db.query(`SELECT custom_fields FROM jobs WHERE id = $1`, [EMP_JOB]);
  assert.deepEqual(j.custom_fields, { [JOB_REQ]: 'שכר חדש', [JOB_HIDDEN]: 'employer tries' });
  await settle();
  const log = await db.query(`SELECT details FROM audit_log WHERE action = 'jobs.edit_request_approved' AND target = $1`, [req.json.data.id]);
  assert.deepEqual([...log.rows[0].details.fields].sort(), [`customFields.${JOB_HIDDEN}`, `customFields.${JOB_REQ}`].sort());
  const leak = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%שכר חדש%'`);
  assert.equal(leak.rows[0].n, 0);
});

await check('clean-up: every field this run added is turned off; the job archived', async () => {
  for (const id of added) assert.equal((await patch(id, { active: false })).status, 200);
  if (JOB) assert.equal((await cm.req('POST', `/api/admin/jobs/${JOB}/archive`)).status, 200);
  if (EMP_JOB) assert.equal((await cm.req('POST', `/api/admin/jobs/${EMP_JOB}/archive`)).status, 200);
  const pub = (await jar().req('GET', '/api/custom-fields/signup')).json.data.fields;
  assert.ok(!pub.some((f) => added.includes(f.id)));
});

await db.end();
for (const [s, name, err] of results) console.log(`${s === 'PASS' ? '✔' : '✖'} ${name}${err ? ` — ${err}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
