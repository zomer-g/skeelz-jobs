// Adversarial checks of the employer role (docs/employers.md, docs/security.md "Employers") against a running LOCAL
// server (fresh dev DB, integrations off, EMAIL_CODE_SIGNIN_ENABLED=true, the mock SSO values from server/.env.example):
//   BASE=http://localhost:3100 [DATABASE_URL=postgresql://…] node test/e2e-employer-isolation.mjs
// What an employer must never get: candidates (lists, applications, CVs, counts tied to people) other than the
// applicants a content manager forwarded for their own job — and of those only the name and the CV (docs/employers.md
// "Applicants"; the full rules are tried in test/e2e-employer-applicants.mjs) —, staff emails, another employer's
// anything, staff-only job fields; and no way to change a job, a role or a setting by themselves.
// - every staff / candidate / CV / log / settings / token route refuses an employer, and the refusal says nothing;
// - IDOR: employer A can't read, edit-request, withdraw or claim anything of employer B by changing ids or bodies;
// - response shapes of /api/employer/* and the session: no candidate fields, no reviewer emails, no other employer;
// - edit requests: allowlisted fields only, HTML made safe on approval, ownership/status/pin unchanged, staff-only
//   approve/reject; archived jobs refused;
// - role transitions: an existing candidate never becomes an employer, staff never, accountType can't escalate,
//   the DB role decides on every request (with DATABASE_URL: a changed role takes effect on the old token).
// Uses 3 of the 5 employer-form submissions an IP may send per hour and most of the 30 writes: restart the server first.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { staffLogin, xhostdSignIn, signedInOk } from './helpers/staffLogin.mjs';
import { devCode, signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('e2e writes data: run it against localhost only');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    clear: () => cookies.clear(),
    snapshot: () => new Map(cookies),
    restore: (m) => { cookies.clear(); for (const [k, v] of m) cookies.set(k, v); },
    async req(method, path, body, extraHeaders = {}) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...extraHeaders };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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
const refused = (r) => r.status === 401 || r.status === 403 || (r.status === 400 && /^(Forbidden|Unauthorized|au\d+)$/.test(String(r.json?.code ?? '')));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
};

const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const phone = () => `05${digits(8)}`;
const anon = jar(), cm = jar(), sec = jar(), empA = jar(), empB = jar(), cand = jar();
const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
const city = (await anon.req('GET', '/api/locations')).json.data.find((l) => l.citySymbol > 0);
const EMP_A = `iso-a-${stamp}@example.test`;
const EMP_B = `iso-b-${stamp}@example.test`;
const CAND = `iso-c-${stamp}@example.test`;
const CAND_PHONE = phone();
const CAND_LAST = `מועמדת${digits(3).replace(/\d/g, 'ק')}`;
const PHONE_A = phone(), PHONE_B = phone();
const COMPANY_B = `חברת בי ${stamp}`;
const form = (title, contactEmail) => ({
  title, companyName: 'חברת בדיקה', citySymbol: city.citySymbol, jobScope: ['FullTime'], requiredSkills: [skills[0]._id],
  description: `תיאור ארוך מספיק של משרה לבדיקת בידוד מעסיקים ${stamp}.`,
  externalLink: '', publicEmail: `apply-${stamp}@example.test`,
  contactName: 'איש קשר', contactEmail, contactPhone: '050-1234567', consent: true, website: '',
});

/** Every string in a JSON value, and every key. */
const walk = (v, out = { keys: new Set(), strings: [] }) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.keys.add(k); walk(x, out); }
  else if (typeof v === 'string') out.strings.push(v);
  return out;
};
/** Keys that mean candidate data or staff-only job fields: never in anything an employer gets. */
const FORBIDDEN_KEYS = ['applications', 'applicants', 'applicationsCount', 'jobApplications', 'cv', 'cvFileUrl', 'cvFilePath',
  'comments', 'managedFields', 'deletedBy', 'uploadBy', 'contactEmail', 'contactPhone', 'contactName', 'contactPersonName',
  'contactPersonPhone', 'e_first', 'employer'];

const employerSignUp = async (client, email, details = {}) => {
  const code = await devCode(client, email);
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  if (v.json?.data?.status !== 'signup') return v;
  return client.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה בע"מ', phone: phone(),
    jobTitle: 'מגייסת', consent: true, marketingConsent: false, ...details,
  });
};
const relogin = async (client, email) => {
  client.clear();
  const r = await candidateLogin(client, email);
  assert.equal(r.status, 200, `re-login ${email}: ${r.text}`);
};

// ---------------------------------------------------------------------------
let idA = '', idB = '', idC = '', jobA = '', jobB = '', reqB = '', reqA = '';

await check('setup: staff sign in, two employers and a candidate sign up', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  assert.equal((await staffLogin(sec, ADMIN_EMAIL)).status, 200);
  const a = await employerSignUp(empA, EMP_A, { phone: PHONE_A });
  assert.equal(a.status, 200, a.text); idA = a.json.data.user._id ?? a.json.data.user.id;
  const b = await employerSignUp(empB, EMP_B, { phone: PHONE_B, companyName: COMPANY_B });
  assert.equal(b.status, 200, b.text); idB = b.json.data.user._id ?? b.json.data.user.id;
  assert.equal(a.json.data.user.role, 'employer');
  const c = await signUp(cand, {
    firstName: 'מועמדת', lastName: CAND_LAST, email: CAND, phoneNumber: CAND_PHONE, dateOfBirth: '1990-01-01T00:00:00.000Z',
    gender: 'other', citySymbol: city.citySymbol, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(c.status, 200, c.text); idC = c.json.data._id;
});

await check('setup: each employer sends a job, a content manager approves both; a candidate applies to A\'s job', async () => {
  for (const [c, t] of [[empA, `ISO-A-${stamp}`], [empB, `ISO-B-${stamp}`]]) {
    const r = await c.req('POST', '/api/job-submissions', form(t.slice(0, 30), `contact-${stamp}@example.test`));
    assert.equal(r.status, 201, r.text);
  }
  const list = (await cm.req('GET', '/api/admin/job-submissions')).json.data.items;
  for (const [t, set] of [[`ISO-A-${stamp}`.slice(0, 30), (v) => { jobA = v; }], [`ISO-B-${stamp}`.slice(0, 30), (v) => { jobB = v; }]]) {
    const s = list.find((x) => x.title === t);
    const ap = await cm.req('POST', `/api/admin/job-submissions/${s.id}/approve`, {});
    assert.equal(ap.status, 200, ap.text);
    set(ap.json.data.jobId);
  }
  const ap = await cand.req('POST', `/api/jobs/apply/${jobA}`);
  assert.equal(ap.status, 200, `the candidate applied: ${ap.text}`);
  // Staff do see the application exists (the employer must not).
  const n = await cm.req('GET', `/api/admin/jobs/${jobA}/applications-count`);
  assert.equal(n.status, 200, n.text);
});

await check('B asks for an edit (pending); a content manager rejects one of A\'s — the reviewer is staff', async () => {
  const rb = await empB.req('POST', `/api/employer/jobs/${jobB}/edit-requests`, { title: `ISO-B2-${stamp}`.slice(0, 30) });
  assert.equal(rb.status, 201, rb.text); reqB = rb.json.data.id;
  const ra = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { title: `ISO-A2-${stamp}`.slice(0, 30) });
  assert.equal(ra.status, 201, ra.text); reqA = ra.json.data.id;
  assert.equal((await cm.req('POST', `/api/admin/job-edit-requests/${reqA}/reject`, { reason: 'לא מתאים' })).status, 200);
});

await check('A\'s whole area: no candidate, no staff email, nothing of B, no staff-only or candidate keys', async () => {
  const bodies = [];
  for (const p of ['/api/employer/me', '/api/employer/submissions', '/api/employer/jobs', `/api/employer/jobs/${jobA}`,
    '/api/employer/edit-requests', '/api/auth/session']) {
    const r = await empA.req('GET', p);
    assert.equal(r.status, 200, `${p}: ${r.status}`);
    bodies.push([p, r]);
  }
  for (const [p, r] of bodies) {
    const { keys, strings } = walk(r.json);
    const text = strings.join('\n');
    for (const bad of [CAND, CAND_PHONE, CAND_LAST, idC, CM_EMAIL, ADMIN_EMAIL, EMP_B, PHONE_B, COMPANY_B, idB, jobB, reqB]) {
      assert.ok(!text.includes(bad), `${p} carries ${bad === idC ? 'the candidate id' : bad === idB ? 'B\'s id' : 'a forbidden value'}`);
    }
    // The edit form of the employer's OWN job carries the job's public contact (owner, 24.11.2026: every field is
    // editable with staff approval); nowhere else.
    const ownEditForm = (k) => /^\/api\/employer\/jobs\/[0-9a-f]{24}$/.test(p) && ['contactPersonName', 'contactPersonPhone'].includes(k);
    const found = FORBIDDEN_KEYS.filter((k) => keys.has(k) && !(p === '/api/auth/session' && k === 'employer') && !ownEditForm(k));
    // The session's user object has an empty cvFileUrl field (the users table shape); it must be empty.
    const realFound = found.filter((k) => !(p === '/api/auth/session' && k === 'cvFileUrl' && r.json.data.user.cvFileUrl === ''));
    assert.deepEqual(realFound, [], `${p} has keys ${realFound.join(',')}`);
  }
  const session = bodies.find(([p]) => p === '/api/auth/session')[1].json.data;
  assert.deepEqual(session.jobApplicationsId, [], 'no applications in the session');
  const rejected = bodies.find(([p]) => p === '/api/employer/edit-requests')[1].json.data.items.find((x) => x.id === reqA);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewedBy, 'staff', 'the reviewer is not named');
  assert.equal(rejected.rejectReason, 'לא מתאים');
});

await check('applicants: nothing before a forward; after it only the name (+ CV flag) of A\'s own applicant, never to B', async () => {
  assert.deepEqual((await empA.req('GET', '/api/employer/applicants')).json.data, { jobs: [], cut: 0 }, 'not forwarded → nothing');
  const pending = (await cm.req('GET', '/api/admin/employer-forwards?state=pending&limit=100')).json.data.items;
  const row = pending.find((x) => x.candidateId === idC && x.jobId === jobA);
  assert.ok(row, 'staff see the application as waiting to be forwarded');
  // An employer can't list, forward or cancel by themselves.
  for (const [m, p] of [['GET', '/api/admin/employer-forwards'], ['POST', '/api/admin/employer-forwards'], ['POST', `/api/admin/employer-forwards/${'a'.repeat(24)}/cancel`]]) {
    const snap = empA.snapshot();
    const x = await empA.req(m, p, m === 'POST' ? { kind: row.kind, applicationId: row.applicationId } : undefined);
    assert.ok(refused(x), `employer ${m} ${p}: ${x.status}`);
    assert.ok(!x.text.includes(CAND_LAST));
    empA.restore(snap);
  }
  const f = await cm.req('POST', '/api/admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId });
  assert.equal(f.status, 201, f.text);
  const r = await empA.req('GET', '/api/employer/applicants');
  assert.equal(r.status, 200, r.text);
  const job = r.json.data.jobs.find((j) => j.jobId === jobA);
  assert.ok(job && job.applicants.length === 1, 'exactly the forwarded applicant');
  assert.deepEqual(Object.keys(job.applicants[0]).sort(), ['forwardId', 'forwardedAt', 'hasCv', 'name']);
  assert.ok(job.applicants[0].name.includes(CAND_LAST), 'the name');
  for (const bad of [CAND, CAND_PHONE, idC, row.applicationId, CM_EMAIL, ADMIN_EMAIL, EMP_B, idB, jobB]) assert.ok(!r.text.includes(bad), 'nothing else');
  assert.deepEqual((await empB.req('GET', '/api/employer/applicants')).json.data.jobs, [], 'B gets nothing of A\'s');
  assert.equal((await empB.req('GET', `/api/employer/applicants?jobId=${jobA}`)).status, 404);
  assert.equal((await empB.req('GET', `/api/employer/applicants/${job.applicants[0].forwardId}/cv`)).status, 404);
});

await check('IDOR: A can\'t open, edit-request or withdraw B\'s job / request (404 / 409, nothing changed)', async () => {
  const one = await empA.req('GET', `/api/employer/jobs/${jobB}`);
  assert.equal(one.status, 404, one.text);
  assert.ok(!one.text.includes(EMP_B) && !one.text.includes('ISO-B'), 'the 404 says nothing about the job');
  const er = await empA.req('POST', `/api/employer/jobs/${jobB}/edit-requests`, { title: 'השתלטות' });
  assert.equal(er.status, 404, er.text);
  const w = await empA.req('POST', `/api/employer/edit-requests/${reqB}/withdraw`, {});
  assert.equal(w.status, 409, w.text);
  assert.equal((await empB.req('GET', '/api/employer/edit-requests')).json.data.items.find((x) => x.id === reqB).status, 'pending');
  // Not a job id, an id of a non-job, a numeric job number, junk: always the same 404.
  for (const id of ['0'.repeat(24), idB, reqB, '1', "' OR 1=1 --", '../me']) {
    const r = await empA.req('GET', `/api/employer/jobs/${encodeURIComponent(id)}`);
    assert.equal(r.status, 404, `${id}: ${r.status}`);
  }
});

await check('IDOR: ids in the body are ignored or refused (edit request, profile)', async () => {
  // One request each (the per-IP write limit is shared): every unknown key is named in the refusal.
  const er = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { title: 'X כותרת חדשה', jobId: jobB, userId: idB, user_id: idB, ownerId: idA });
  assert.equal(er.status, 400, er.text);
  assert.equal(er.json.code, 'bad_field');
  assert.deepEqual([...er.json.fields].sort(), ['jobId', 'ownerId', 'userId', 'user_id'].sort());
  const pr = await empA.req('PATCH', '/api/employer/me', { companyName: 'חדשה בע"מ', email: EMP_B, role: 'admin', id: idB, userId: idB, accountType: 'admin' });
  assert.equal(pr.status, 400, pr.text);
  assert.deepEqual([...pr.json.fields].sort(), ['accountType', 'email', 'id', 'role', 'userId'].sort());
  const me = (await empA.req('GET', '/api/employer/me')).json.data;
  assert.equal(me.email, EMP_A);
  assert.equal(me.id, idA);
  const b = (await empB.req('GET', '/api/employer/me')).json.data;
  assert.equal(b.companyName, COMPANY_B, 'B unchanged');
});

await check('claim: only the session\'s verified email counts — A can\'t claim a submission sent with B\'s address', async () => {
  const r = await anon.req('POST', '/api/job-submissions', form(`ISO-ANON-${stamp}`.slice(0, 30), EMP_B));
  assert.equal(r.status, 201, r.text);
  const c = await empA.req('POST', '/api/employer/submissions/claim', { email: EMP_B, userId: idB });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.data.claimed, 0);
  assert.equal((await empB.req('GET', '/api/employer/me')).json.data.claimable, 1, 'still B\'s to claim');
  const cb = await empB.req('POST', '/api/employer/submissions/claim', {});
  assert.equal(cb.json.data.claimed, 1);
  assert.ok(!(await empA.req('GET', '/api/employer/submissions')).json.data.items.some((x) => x.title.startsWith('ISO-ANON')));
});

// Owner, 24.11.2026: an employer may ask to change every field of the job (status, its contact, apply settings, added
// fields: test/e2e-role-blocks.mjs) — never how SKEELZ runs the board.
await check('edit request allowlist: pin, sponsored, dates, comments, board and system fields → 400 bad_field', async () => {
  const FIELDS = ['isPinned', 'pinnedAt', 'isSponsored', 'isMarked', 'publishDate', 'applyPolicy', 'quickApply',
    'isSelfApply', 'comments', 'jobId', 'uploadBy', 'deletedAt', 'importedFromLive', 'isPrivate', 'managedFields',
    'legacyState', 'archivedAt', 'bumpedAt', 'visibility', 'schedulePublish'];
  for (const part of [FIELDS.slice(0, 10), FIELDS.slice(10)]) {
    const body = Object.fromEntries(part.map((f) => [f, true]));
    const r = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { title: 'X כותרת חדשה', ...body });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, 'bad_field');
    assert.deepEqual([...r.json.fields].sort(), [...part].sort());
  }
  const js = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { externalLink: 'javascript:alert(1)' });
  assert.equal(js.status, 400, js.text);
  const mail = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { publicEmail: 'not an email<script>' });
  assert.equal(mail.status, 400, mail.text);
});

await check('edit request: pending changes nothing; approval applies only the fields, HTML made safe, owner/status kept', async () => {
  const before = (await anon.req('GET', `/api/jobs/${jobA}`)).json.data;
  const evil = `תיאור חדש וארוך מספיק <script>alert(1)</script> <img src=x onerror=alert(1)> <a href="javascript:x">y</a> ${stamp}`;
  const r = await empA.req('POST', `/api/employer/jobs/${jobA}/edit-requests`, { description: evil, title: `ISO-A3-${stamp}`.slice(0, 30) });
  assert.equal(r.status, 201, r.text);
  const mid = (await anon.req('GET', `/api/jobs/${jobA}`)).json.data;
  assert.equal(mid.title, before.title, 'live job unchanged while pending');
  assert.equal(mid.description, before.description);
  // The employer can't approve or reject it.
  for (const act of ['approve', 'reject']) {
    const snap = empA.snapshot();
    const x = await empA.req('POST', `/api/admin/job-edit-requests/${r.json.data.id}/${act}`, {});
    assert.ok(refused(x), `employer ${act}: ${x.status}`);
    empA.restore(snap);
  }
  // A content manager approves; a body can't add changes.
  const ap = await cm.req('POST', `/api/admin/job-edit-requests/${r.json.data.id}/approve`, { changes: { status: 'Archived' }, status: 'Archived' });
  assert.equal(ap.status, 200, ap.text);
  const after = (await anon.req('GET', `/api/jobs/${jobA}`)).json.data;
  assert.equal(after.title, `ISO-A3-${stamp}`.slice(0, 30));
  assert.equal(after.status, before.status, 'status unchanged');
  // Only the converter's own tags (<p>, <br>) are real tags; everything the employer typed is text (&lt;…&gt;).
  assert.ok(!/<(?!\/?(p|br)\b)/i.test(after.description) && after.description.includes('&lt;script&gt;'), `description is safe: ${after.description.slice(0, 120)}`);
  assert.equal(!!after.isSponsored, !!before.isSponsored);
  const own = (await empA.req('GET', '/api/employer/jobs')).json.data.items.find((x) => x.id === jobA);
  assert.ok(own, 'still A\'s job');
  assert.ok(!(await empB.req('GET', '/api/employer/jobs')).json.data.items.some((x) => x.id === jobA), 'never B\'s');
});

await check('archived job: no edit request (409 job_archived)', async () => {
  assert.equal((await cm.req('POST', `/api/admin/jobs/${jobB}/archive`, {})).status, 200);
  // B's pending request is still there; withdraw it first, then a new one is refused.
  assert.equal((await empB.req('POST', `/api/employer/edit-requests/${reqB}/withdraw`, {})).status, 200);
  const r = await empB.req('POST', `/api/employer/jobs/${jobB}/edit-requests`, { title: `ISO-B9-${stamp}`.slice(0, 30) });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'job_archived');
});

await check('public routes with an employer session: the same answer as anonymous (no comments, no counts)', async () => {
  const a = await anon.req('GET', `/api/jobs/${jobA}`);
  const e = await empA.req('GET', `/api/jobs/${jobA}`);
  assert.equal(e.status, 200);
  assert.deepEqual(Object.keys(e.json.data).sort(), Object.keys(a.json.data).sort(), 'same fields as anonymous');
  assert.ok(!('comments' in e.json.data));
  const archived = await empB.req('GET', `/api/jobs/${jobB}`);
  assert.equal(archived.status, 404, 'an archived job (even their own) is not opened through the public route');
  for (const p of ['/api/public/v1/jobs', `/api/public/v1/jobs/${jobA}`]) {
    const r = await empA.req('GET', p);
    const { keys } = walk(r.json);
    for (const k of ['applications', 'applicationsCount', 'comments', 'uploadBy']) assert.ok(!keys.has(k), `${p} has ${k}`);
  }
  const mcp = await empA.req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { Accept: 'application/json, text/event-stream' });
  assert.ok(!/candidate|application_id|cv_/i.test(mcp.text.replace(/applyMode|apply/gi, '')), 'MCP offers no candidate tools');
});

await check('internal API: an employer session is no key (401 on every people route)', async () => {
  for (const p of ['/api/internal/v1/candidates', `/api/internal/v1/candidates/${idC}`, '/api/internal/v1/applications',
    `/api/internal/v1/candidates/${idC}/cv`, '/api/internal/v1/jobs']) {
    const r = await empA.req('GET', p);
    assert.ok(r.status === 401 || r.status === 403, `${p}: ${r.status}`);
    assert.ok(!r.text.includes(CAND) && !r.text.includes(idC.slice(0, 8) + 'x'), 'nothing personal');
  }
});

await check('every staff / candidate / CV / log / settings / token route refuses an employer; the refusal says nothing', async () => {
  const routes = [
    ['GET', '/api/users'], ['GET', `/api/users?search=${encodeURIComponent(CAND)}`], ['PATCH', `/api/users/${idC}`],
    ['GET', '/api/users/me'], ['PATCH', '/api/users/me'], ['DELETE', '/api/users/me/cv'], ['PUT', '/api/users/me/marketing-consent'],
    ['GET', '/api/users/me/cv'], ['GET', '/api/users/me/cv/file'], ['GET', `/api/users/job-applications/${idC}`],
    ['GET', `/api/users/job-applications/${idA}`], ['GET', `/api/files/${idC}`], ['POST', `/api/jobs/apply/${jobA}`],
    ['GET', '/api/admin/guest-applications'], ['GET', `/api/admin/guest-applications/${'a'.repeat(24)}/cv`],
    ['POST', '/api/admin/guest-applications/salesforce-push'], ['GET', '/api/admin/job-submissions'],
    ['GET', `/api/admin/job-submissions/${'a'.repeat(24)}`], ['PATCH', `/api/admin/job-submissions/${'a'.repeat(24)}`],
    ['POST', `/api/admin/job-submissions/${'a'.repeat(24)}/approve`], ['GET', '/api/admin/job-edit-requests'],
    ['GET', `/api/admin/job-edit-requests/${reqB}`], ['POST', `/api/admin/job-edit-requests/${reqB}/reject`],
    ['GET', '/api/admin/jobs/with-comments'], ['GET', `/api/admin/jobs/${jobA}/applications-count`],
    ['POST', `/api/admin/jobs/${jobA}/pin`], ['PATCH', `/api/admin/jobs/${jobA}/board`], ['POST', `/api/admin/jobs/${jobA}/archive`],
    ['PATCH', `/api/jobs/${jobA}`], ['POST', '/api/jobs'],
    ['GET', '/api/admin/settings/apply-policy'], ['PUT', '/api/admin/settings/apply-policy'],
    ['GET', '/api/admin/settings/employer-posting'], ['PUT', '/api/admin/settings/employer-posting'],
    ['GET', '/api/admin/security'], ['POST', '/api/admin/security/grant'], ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/staff'], ['POST', '/api/admin/staff'], ['PATCH', `/api/admin/staff/${idA}/role`],
    ['GET', '/api/admin/api-tokens'], ['POST', '/api/admin/api-tokens'], ['POST', '/api/internal/sandbox-refresh'],
  ];
  // The gate signs a refused session out (refresh token revoked): the access token we keep is still valid
  // for 15 minutes, so each request below is a live employer session.
  const snap = empA.snapshot();
  for (const [m, p] of routes) {
    empA.restore(snap);
    const body = ['POST', 'PUT', 'PATCH'].includes(m) ? { mode: 'open', title: 'x', role: 'admin', email: EMP_A, scopes: ['candidates:read'] } : undefined;
    const r = await empA.req(m, p, body);
    assert.ok(refused(r), `${m} ${p}: ${r.status} ${r.text.slice(0, 80)}`);
    for (const bad of [CAND, CAND_PHONE, CAND_LAST, idC, CM_EMAIL, ADMIN_EMAIL, EMP_B]) {
      assert.ok(!r.text.includes(bad), `${m} ${p}: the refusal carries personal data`);
    }
    assert.ok(!/@/.test(r.text), `${m} ${p}: an address in the refusal`);
  }
  empA.restore(snap);
  assert.equal((await empA.req('GET', '/api/employer/me')).status, 200, 'still an employer session');
  assert.equal((await anon.req('GET', '/api/job-submissions/policy')).json.data.mode, 'open', 'the setting was not changed');
  // Each refusal is logged with the DB role, ids only.
  const log = (await sec.req('GET', `/api/admin/audit?action=access.denied&actor=${encodeURIComponent(`user:${idA}`)}`)).json.data.entries;
  assert.ok(log.length >= 10, `refusals logged (${log.length})`);
  assert.ok(log.every((e) => !JSON.stringify(e.details ?? {}).includes('@')), 'no address in the details');
  assert.ok(log.some((e) => String(e.details?.reason ?? '').includes('role:employer')), 'the DB role is the reason');
});

await check('role transitions: an existing candidate never becomes an employer (email code, xhostd)', async () => {
  // Email code: the candidate's address signs in to the candidate account; no sign-up cookie, so the form is refused.
  const c = jar();
  const code = await devCode(c, CAND);
  const v = await c.req('POST', '/api/auth/email/verify', { email: CAND, code });
  assert.equal(v.json?.data?.status, 'signed_in', v.text);
  const s = await c.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone(), consent: true });
  assert.equal(s.status, 401, s.text);
  // xhostd (Google): the candidate's address signs in to the candidate; the sign-up form is refused too.
  const g = jar();
  assert.ok(signedInOk(await xhostdSignIn(g, CAND)), 'xhostd sign-in links the candidate');
  const gs = await g.req('POST', '/api/auth/xhostd/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone(), consent: true });
  assert.equal(gs.status, 401, gs.text);
  assert.equal((await g.req('GET', '/api/auth/session')).json.data.user.role, 'user');
  // An employer's address signs in to the employer account, never a candidate one.
  const e = jar();
  assert.ok(signedInOk(await xhostdSignIn(e, EMP_A)), 'xhostd sign-in of an employer address');
  assert.equal((await e.req('GET', '/api/auth/session')).json.data.user.role, 'employer');
  const cs = await e.req('POST', '/api/auth/xhostd/signup', { firstName: 'מועמד', lastName: 'חדש', phoneNumber: phone(), citySymbol: city.citySymbol, gender: 'other', dateOfBirth: '1990-01-01T00:00:00.000Z', consent: true });
  assert.equal(cs.status, 401, cs.text);
});

// Several roles per account (owner, 23.11.2026): an admin MAY add a staff role to an employer's account (that is
// e2e-multi-role.mjs). Here: a staff-only address still gets no sign-up form by code, and the staff screen's role
// change works on staff ids only (an employer-only account is not one: 404 / 409).
await check('role transitions: a staff-only address gets no sign-up form; the staff role change takes staff ids only', async () => {
  const c = jar();
  const r = await c.req('POST', '/api/dev/email-code', { email: CM_EMAIL });
  if (r.status === 200) {
    const v = await c.req('POST', '/api/auth/email/verify', { email: CM_EMAIL, code: r.json.data.code });
    assert.notEqual(v.json?.data?.status, 'signup', 'a staff address never gets the sign-up form');
    const s = await c.req('POST', '/api/auth/email/signup', { accountType: 'employer', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone(), consent: true });
    assert.notEqual(s.status, 200, s.text);
  }
  const set = await sec.req('PATCH', `/api/admin/staff/${idA}/role`, { role: 'admin' });
  assert.ok(set.status === 404 || set.status === 409, `role change of an employer: ${set.status}`);
  assert.equal((await empB.req('GET', '/api/employer/me')).status, 200);
});

await check('role transitions: accountType can\'t escalate; the email is the verified one, never the body\'s', async () => {
  const NEW = `iso-n-${stamp}@example.test`;
  const c = jar();
  const code = await devCode(c, NEW);
  assert.equal((await c.req('POST', '/api/auth/email/verify', { email: NEW, code })).json.data.status, 'signup');
  for (const accountType of ['admin', 'content_manager', 'staff']) {
    const r = await c.req('POST', '/api/auth/email/signup', { accountType, role: 'admin', firstName: 'דנה', lastName: 'מעסיקה', companyName: 'אקמה', phone: phone(), consent: true });
    // Not 'employer' → the candidate form, which needs candidate fields: refused, nothing created.
    assert.notEqual(r.status, 200, `${accountType}: ${r.text}`);
  }
  const ok = await c.req('POST', '/api/auth/email/signup', {
    accountType: 'employer', role: 'admin', userRole: 'admin', email: EMP_B, firstName: 'נועה', lastName: 'חדשה', companyName: 'חדשה בע"מ',
    phone: phone(), consent: true,
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.data.user.role, 'employer');
  assert.equal(ok.json.data.user.email, NEW, 'the cookie\'s address');
  assert.equal((await c.req('GET', '/api/employer/me')).json.data.email, NEW);
  const snap = c.snapshot();
  assert.ok(refused(await c.req('GET', '/api/admin/audit')));
  c.restore(snap);
});

await check('the DB role decides on every request: a changed role takes effect on the old token (DATABASE_URL)', async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const snap = empB.snapshot();
    await db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [idB]);
    const r = await empB.req('GET', '/api/employer/me');
    assert.ok(refused(r), `old employer token after the role changed: ${r.status}`);
    await db.query(`UPDATE users SET role = 'employer' WHERE id = $1`, [idB]);
    empB.restore(snap);
    assert.equal((await empB.req('GET', '/api/employer/me')).status, 200, 'back to employer: the same token works again');
    // A forged token claiming admin: the role in a token is never read.
    const tok = [...snap].find(([k]) => k === 'access_token')?.[1];
    if (tok) {
      const [h, p] = tok.split('.');
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, userRole: 'admin' })).toString('base64url')}.${tok.split('.')[2]}`;
      const f = jar(); f.setCookie('access_token', forged);
      assert.ok(refused(await f.req('GET', '/api/admin/audit')), 'a tampered token is refused');
    }
  } finally {
    await db.query(`UPDATE users SET role = 'employer' WHERE id = $1`, [idB]).catch(() => undefined);
    await db.end();
  }
});

await check('employer actions are logged with ids and field names only (no names, emails, phones)', async () => {
  const entries = [];
  for (const action of ['employer.profile_updated', 'employer.submissions_claimed', 'jobs.edit_requested', 'jobs.edit_withdrawn',
    'auth.signup_employer', 'jobs.edit_request_approved', 'jobs.edit_request_rejected', 'jobs.submitted']) {
    const r = await sec.req('GET', `/api/admin/audit?action=${action}`);
    assert.equal(r.status, 200, r.text);
    entries.push(...r.json.data.entries.map((e) => ({ ...e, action })));
  }
  assert.ok(entries.some((e) => e.action === 'jobs.edit_requested'), 'edit requests are logged');
  for (const e of entries) {
    const d = JSON.stringify(e.details ?? {});
    for (const bad of [EMP_A, EMP_B, PHONE_A, PHONE_B, COMPANY_B, CAND, 'דנה', 'מעסיקה']) {
      assert.ok(!d.includes(bad), `${e.action} details carry personal data`);
    }
    if (e.actor && !/^(user:|anonymous:|[^@]+@example\.test$)/.test(e.actor)) assert.fail(`${e.action}: odd actor`);
    if (String(e.actor).startsWith('user:')) continue;
    assert.ok(![EMP_A, EMP_B].includes(e.actor), 'an employer is logged as user:<id>, not by email');
  }
});

for (const r of results) console.log(r[0], r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
