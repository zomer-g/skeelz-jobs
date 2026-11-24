// Activity log gaps (docs/security.md "Sign-ins and unusual sign-ins"): every sign-in and sign-up carries the address
// and a device summary; every CV upload is logged (ids only); unusual sign-ins raise alerts; admins have a per-person
// view, which is itself logged. Fresh DB; restart the server first (it spends sign-in requests).
//   BASE=http://localhost:3100 node test/e2e-activity-log.mjs
// The server trusts one proxy hop (trust proxy 1), so X-Forwarded-For sets the address a request comes from.
// Never point this at production.
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== 'true') {
  throw new Error('e2e writes data: run it against localhost only');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || process.env.CONTENT_MANAGER_EMAIL || 'content@example.test';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A cookie jar that comes from one address with one browser. */
const jar = (ip, ua = CHROME_WIN) => {
  const cookies = new Map();
  return {
    ip,
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'User-Agent': ua, 'X-Forwarded-For': ip };
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(BASE + path, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
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
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pdfBytes = async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Test CV');
  return Buffer.from(await doc.save());
};
const upload = async (client, token, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdfBytes()], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};
const stamp = Date.now();
const rnd = () => Math.floor(Math.random() * 200) + 20;
const ipA = `198.51.100.${rnd()}`;
const ipB = `203.0.113.${rnd()}`;
const sharedIp = `192.0.2.${rnd()}`;
const profile = (email, phone, extra = {}) => ({
  firstName: 'Log', lastName: 'Test', email, phoneNumber: phone, dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other',
  citySymbol: 9000, skills: [], hasAppliedToJob: false, consent: true, ...extra,
});

const sysAdmin = jar(`198.18.0.${rnd()}`);
const cm = jar(ipA);
const log = async (q) => {
  const r = await sysAdmin.req('GET', `/api/admin/audit?${q}`);
  assert.equal(r.status, 200, r.text);
  return r.json.data.entries;
};
/** Entries are written right after the answer (void writes): give them a moment. */
const settle = () => wait(400);

assert.equal((await staffLogin(sysAdmin, ADMIN_EMAIL)).status, 200, 'admin sign-in');

// ---- 1. sign-ins and sign-ups carry the address and the device ----
let candidateId = '';
let candidateUploadRef = '';
const candEmail = `log-${stamp}@example.test`;
const cand = jar(`198.51.100.${rnd()}`, SAFARI_IOS);
await check('sign-up by email code: auth.email_code_signup + auth.login carry ip + device, never the email', async () => {
  const t = crypto.randomUUID();
  assert.equal((await upload(cand, t, 'log_test_private_name.pdf')).status, 200);
  const r = await signUp(cand, profile(candEmail, `05${String(stamp).slice(-8)}`, { cvFileUrl: `${t}/log_test_private_name.pdf` }));
  assert.equal(r.status, 200, r.text);
  candidateId = r.json.data._id;
  await settle();
  const su = (await log(`actor=user:${candidateId}&action=auth.email_code_signup`))[0];
  assert.ok(su, 'sign-up entry');
  assert.equal(su.details.ip, cand.ip);
  assert.equal(su.details.device, 'Safari · iOS');
  const li = (await log(`actor=user:${candidateId}&action=auth.login`))[0];
  assert.ok(li, 'login entry');
  assert.equal(li.details.ip, cand.ip);
  assert.equal(li.details.device, 'Safari · iOS');
  assert.equal(li.details.method, 'email_code');
  assert.ok(!JSON.stringify([su, li]).includes(candEmail), 'no email in the entries');
});

await check('staff sign-in (xhostd SSO) carries ip + device + method; first sign-in with an address raises nothing', async () => {
  assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200);
  await settle();
  const li = (await log(`actor=${encodeURIComponent(CM_EMAIL)}&action=auth.login`))[0];
  assert.equal(li.details.ip, ipA);
  assert.equal(li.details.device, 'Chrome · Windows');
  assert.equal(li.details.method, 'xhostd');
  assert.equal(li.details.role, 'content_manager');
  assert.ok(!('user_agent' in li.details) && !JSON.stringify(li.details).includes('537.36'), 'never the full user agent');
  const s = (await sysAdmin.req('GET', '/api/admin/security')).json.data;
  assert.ok(!s.alerts.some((a) => a.kind === 'signin_new_address' && a.user_email === CM_EMAIL), 'no new-address alert yet');
});

await check('candidate sign-in by code from another browser: the new address + device are logged', async () => {
  const again = jar(`198.51.100.${rnd()}`, CHROME_WIN);
  assert.equal((await candidateLogin(again, candEmail)).status, 200);
  await settle();
  const li = (await log(`actor=user:${candidateId}&action=auth.login`))[0];
  assert.equal(li.details.ip, again.ip);
  assert.equal(li.details.device, 'Chrome · Windows');
});

// ---- 2. every CV upload is logged (ids only) ----
await check('upload at sign-up: cv.uploaded + cv.attached (via signup), same upload ref, no key / file name / email', async () => {
  const att = (await log(`subject=${candidateId}&action=cv.attached`)).find((e) => e.details.via === 'signup');
  assert.ok(att, 'cv.attached via signup');
  assert.equal(att.target, candidateId);
  assert.match(att.details.upload, /^upload#[0-9a-f]{12}$/);
  candidateUploadRef = att.details.upload;
  const up = (await log('action=cv.uploaded')).find((e) => e.details.upload === candidateUploadRef);
  assert.ok(up, 'the matching cv.uploaded');
  assert.equal(up.details.type, 'pdf');
  assert.ok(up.details.size_kb > 0);
  const all = JSON.stringify([...(await log('action=cv.'))]);
  for (const bad of ['post-scan', '.pdf', 'log_test', '@']) assert.ok(!all.includes(bad), `no ${bad} in cv entries`);
});

let jobIds = [];
await check('upload in the personal area and with an application: cv.attached via profile / application', async () => {
  for (let i = 0; i < 2; i++) {
    const title = `Log job ${i} ${stamp}`;
    const r = await cm.req('POST', '/api/jobs', {
      title, jobScope: ['FullTime'], companyName: 'Log Co', publishDate: new Date().toISOString(), citySymbol: 9000,
      description: '<p>log</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [], isSponsored: false, isMarked: false, isSelfApply: false,
    });
    assert.equal(r.status, 200, r.text);
    jobIds.push(r.json.data.id);
  }
  const t1 = crypto.randomUUID();
  assert.equal((await upload(cand, t1, 'profile_cv.pdf')).status, 200);
  const p = await cand.req('PATCH', '/api/users/me', { cvFileUrl: `${t1}/profile_cv.pdf` });
  assert.equal(p.status, 200, p.text);
  const t2 = crypto.randomUUID();
  assert.equal((await upload(cand, t2, 'job_cv.pdf')).status, 200);
  const a = await cand.req('POST', `/api/jobs/apply/${jobIds[0]}`, { cv: { mode: 'jobOnly', cvFilePath: `${t2}/job_cv.pdf` } });
  assert.equal(a.status, 200, a.text);
  await settle();
  const vias = (await log(`subject=${candidateId}&action=cv.attached`)).map((e) => e.details.via);
  assert.ok(vias.includes('profile'), `profile in ${vias}`);
  assert.ok(vias.includes('application'), `application in ${vias}`);
  // A signed-in uploader is named in cv.uploaded (not anonymous:<address>).
  const prof = (await log(`subject=${candidateId}&action=cv.attached`)).find((e) => e.details.via === 'profile');
  const up = (await log('action=cv.uploaded')).find((e) => e.details.upload === prof.details.upload);
  assert.ok(up, 'the matching cv.uploaded');
  assert.equal(up.actor, `user:${candidateId}`);
});

await check('guest application with a CV: cv.attached via guest_application (guest id, no email)', async () => {
  const g = jar(`198.51.100.${rnd()}`);
  const t = crypto.randomUUID();
  assert.equal((await upload(g, t, 'guest_cv.pdf')).status, 200);
  const guestEmail = `guest-log-${stamp}@example.test`;
  const r = await g.req('POST', '/api/jobs/guestApply', {
    consent: true, jobData: { _id: jobIds[1] },
    guestData: { fullName: 'Guest Log', email: guestEmail, phoneNumber: '0501111111', cvFilePath: `${t}/guest_cv.pdf` },
  });
  assert.equal(r.status, 200, r.text);
  await settle();
  const e = (await log('action=cv.attached')).find((x) => x.details.via === 'guest_application');
  assert.ok(e, 'guest attach');
  assert.equal(e.details.guest, true);
  assert.equal(e.actor, `anonymous:${g.ip}`);
  assert.ok(!JSON.stringify(e).includes(guestEmail) && !JSON.stringify(e).includes('Guest Log'));
});

// ---- 3. unusual sign-ins → alerts ----
await check('staff sign-in from an address the account has not used → signin_new_address alert (ip + device)', async () => {
  const cm2 = jar(ipB, SAFARI_IOS);
  assert.equal((await staffLogin(cm2, CM_EMAIL)).status, 200);
  await settle();
  const s = (await sysAdmin.req('GET', '/api/admin/security')).json.data;
  const a = s.alerts.find((x) => x.kind === 'signin_new_address' && x.user_email === CM_EMAIL);
  assert.ok(a, 'alert raised');
  assert.equal(a.details.ip, ipB);
  assert.equal(a.details.device, 'Safari · iOS');
});

await check('burst of refused sign-in attempts on a staff account → signin_failures_staff alert', async () => {
  for (let i = 0; i < 5; i++) {
    const x = jar(`100.64.${rnd()}.${rnd()}`);
    const r = await x.req('POST', '/api/auth/email/request', { email: ADMIN_EMAIL });
    assert.ok([200, 429].includes(r.status), `request ${i}: ${r.status}`);
  }
  await settle();
  const s = (await sysAdmin.req('GET', '/api/admin/security')).json.data;
  const a = s.alerts.find((x) => x.kind === 'signin_failures_staff' && x.user_email === ADMIN_EMAIL);
  assert.ok(a, `alert raised: ${JSON.stringify(s.alerts.map((x) => x.kind))}`);
  assert.ok(a.details.failures >= 5);
  const tries = await log('action=auth.email_code_');
  assert.ok(tries.some((e) => e.details?.account && e.details.ip), 'failed attempts carry the account + address');
});

await check('many accounts signing in from one address → signin_many_accounts alert', async () => {
  for (let i = 0; i < 10; i++) {
    const c = jar(sharedIp);
    const r = await signUp(c, profile(`log-shared-${i}-${stamp}@example.test`, `05${String(stamp + i + 1).slice(-8)}`));
    assert.equal(r.status, 200, `account ${i}: ${r.text}`);
  }
  await settle();
  const s = (await sysAdmin.req('GET', '/api/admin/security')).json.data;
  const a = s.alerts.find((x) => x.kind === 'signin_many_accounts' && x.user_email === `address:${sharedIp}`);
  assert.ok(a, 'alert raised');
  assert.ok(a.details.accounts >= 10);
});

// ---- 4. per-person view ----
await check('per-person view of a staff account: sign-ins with address + device, failures, logged before it is sent', async () => {
  const r = await sysAdmin.req('GET', `/api/admin/audit/person?who=${encodeURIComponent(CM_EMAIL)}`);
  assert.equal(r.status, 200, r.text);
  const d = r.json.data;
  assert.equal(d.account.email, CM_EMAIL);
  assert.equal(d.account.role, 'content_manager');
  assert.ok(d.totals.signins >= 2);
  const ips = d.addresses.map((x) => x.ip);
  assert.ok(ips.includes(ipA) && ips.includes(ipB), `addresses ${ips}`);
  assert.ok(d.entries.some((e) => e.action === 'job.created'), 'its staff actions are there');
  const viewed = (await log('action=audit.person_viewed'))[0];
  assert.equal(viewed.actor, ADMIN_EMAIL);
  assert.equal(viewed.target, `user:${d.account.id}`);
  const signins = await sysAdmin.req('GET', `/api/admin/audit/person?who=${encodeURIComponent(CM_EMAIL)}&group=signins`);
  assert.ok(signins.json.data.entries.length > 0 && signins.json.data.entries.every((e) => e.action.startsWith('auth.')));
});

await check('per-person view of a candidate: id + role only (no email), applications, uploads, sign-ins', async () => {
  const r = await sysAdmin.req('GET', `/api/admin/audit/person?who=user:${candidateId}`);
  assert.equal(r.status, 200, r.text);
  const d = r.json.data;
  assert.equal(d.account.email, null);
  assert.equal(d.account.role, 'user');
  assert.ok(!r.text.includes(candEmail), 'the email is not in the answer');
  const actions = new Set(d.entries.map((e) => e.action));
  for (const a of ['auth.login', 'auth.email_code_signup', 'cv.attached', 'job.applied']) assert.ok(actions.has(a), a);
  assert.ok(d.totals.applications >= 1 && d.totals.uploads >= 3 && d.totals.signins >= 2, JSON.stringify(d.totals));
  assert.equal(d.addresses.length, 2);
  const failed = await sysAdmin.req('GET', `/api/admin/audit/person?who=${encodeURIComponent(ADMIN_EMAIL)}`);
  assert.ok(failed.json.data.totals.failures >= 5, 'failed attempts on the account are part of its activity');
});

await check('per-person view is admin-only; unknown account → 404', async () => {
  // Gate refusals answer 400/401/403 here (AxiosError → 400, as on every gated route); never the data.
  for (const who of [cm, cand, jar('198.51.100.9')]) {
    const r = await who.req('GET', `/api/admin/audit/person?who=user:${candidateId}`);
    assert.ok([400, 401, 403].includes(r.status), `refused: ${r.status}`);
    assert.ok(!r.text.includes('"entries"') && !r.text.includes('addresses'), 'nothing of the account');
  }
  assert.equal((await sysAdmin.req('GET', `/api/admin/audit/person?who=user:${'c'.repeat(24)}`)).status, 404);
  assert.equal((await sysAdmin.req('GET', '/api/admin/audit/person?who=nobody')).status, 404);
});

for (const [s, n, m] of results) console.log(`${s}  ${n}${m ? `\n      ${m}` : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
