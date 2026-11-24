// End-to-end checks against a running local server (dev DB, integrations off).
//   BASE=http://localhost:3100 ADMIN_EMAIL=... CM_EMAIL=... node test/e2e.mjs
// Candidates sign in by a code sent by email (helpers/candidate.mjs reads it from the DEV_MODE-only endpoint).
// Staff sign in only with "Continue with Google" (xhostd SSO): start the server with the mock values in helpers/staffLogin.mjs.
// The content manager (jobs + candidates) and the admin (all of that, plus security) come from server/.env.example.
// Never point this at production.
import { PDFDocument } from 'pdf-lib';
import assert from 'node:assert/strict';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== 'true') {
  throw new Error('e2e writes data: run it against localhost only');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password-123';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const CM_PASSWORD = process.env.CM_PASSWORD || 'dev-content-password-123';

const jar = () => {
  const cookies = new Map();
  return {
    setCookie: (k, v) => cookies.set(k, v),
    async req(method, path, body, isForm = false) {
      const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
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

const pdfBytes = async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText('Test CV');
  return Buffer.from(await doc.save());
};
const upload = async (client, token, name = 'cv_test.pdf') => {
  const fd = new FormData();
  fd.append('file', new Blob([await pdfBytes()], { type: 'application/pdf' }), name);
  return client.req('POST', `/api/files/${token}`, fd, true);
};

const anon = jar();
const admin = jar();   // content manager: jobs and candidates
const sysAdmin = jar(); // admin: security and staff, and everything a content manager does
const user = jar();
const stamp = Date.now();
const jobs = (await anon.req('GET', '/api/jobs/active')).json.data.jobs;
const someJob = jobs[0];

await check('GET / is 200 (health)', async () => assert.equal((await anon.req('GET', '/')).status, 200));

await check('map search: jobs near a point, nearest first, bad input rejected', async () => {
  // Tel Aviv, 100 km: any job in a located town in the centre should be in range.
  const r = await anon.req('GET', '/api/jobs/near?lat=32.0853&lng=34.7818&radiusKm=100');
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.ok(Array.isArray(d.jobs) && typeof d.withoutCoordinates === 'number' && typeof d.remote === 'number');
  assert.equal(d.total, d.jobs.length);
  // Pinned jobs come first (docs/jobs-management.md), then nearest first.
  const unpinned = d.jobs.filter((j) => !j.pinnedAt);
  assert.deepEqual(d.jobs.slice(0, d.jobs.length - unpinned.length).every((j) => j.pinnedAt), true);
  for (let i = 1; i < unpinned.length; i++) assert.ok(unpinned[i].distanceKm >= unpinned[i - 1].distanceKm);
  for (const j of d.jobs) assert.ok(j.distanceKm <= 100 && j.status === 'Active' && j.location?.lat != null);
  assert.equal((await anon.req('GET', '/api/jobs/near?lat=48.8&lng=2.3&radiusKm=10')).status, 400);
  assert.equal((await anon.req('GET', '/api/jobs/near?lat=32&lng=34.8&radiusKm=5000')).status, 400);
});

await check('anonymous cannot create a job', async () => {
  const r = await anon.req('POST', '/api/jobs', { title: 'x' });
  assert.notEqual(r.status, 200);
  assert.equal(r.json?.code, 'au2');
});
await check('anonymous cannot edit a job', async () => {
  const r = await anon.req('PATCH', `/api/jobs/${someJob._id}`, { title: 'hacked' });
  assert.notEqual(r.status, 200);
  const again = (await anon.req('GET', `/api/jobs/${someJob._id}`)).json.data;
  assert.equal(again.title, someJob.title);
});
await check('anonymous cannot list someone\'s applications', async () => {
  const r = await anon.req('GET', `/api/users/job-applications/${'a'.repeat(24)}`);
  assert.notEqual(r.status, 200);
});
await check('anonymous cannot delete a file that is not a pending upload', async () => {
  const r = await anon.req('DELETE', `/api/files/?cvFileUrl=${encodeURIComponent('post-scan/abcdefgh-1234/cv.pdf')}&userId=${'b'.repeat(24)}`);
  assert.notEqual(r.status, 200);
});
await check('public job has no internal comments', async () => {
  const r = await anon.req('GET', `/api/jobs/${someJob._id}`);
  assert.equal(r.status, 200);
  assert.ok(!('comments' in r.json.data));
});

// --- staff: content manager (`admin` jar) and admin (`sysAdmin` jar) ---
await check('content manager and admin log in with their roles', async () => {
  const r = await staffLogin(admin, CM_EMAIL);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'content_manager');
  assert.ok(!('password' in r.json.data.user));
  const a = await staffLogin(sysAdmin, ADMIN_EMAIL);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.data.user.role, 'admin');
});
await check('content manager cannot open the security screen or staff users', async () => {
  const c = jar();
  assert.equal((await staffLogin(c, CM_EMAIL)).status, 200);
  assert.notEqual((await c.req('GET', '/api/admin/security')).status, 200);
  const c2 = jar();
  assert.equal((await staffLogin(c2, CM_EMAIL)).status, 200);
  assert.notEqual((await c2.req('GET', '/api/admin/staff')).status, 200);
  // signing in again replaced the `admin` jar's refresh token: sign that jar in again
  assert.equal((await staffLogin(admin, CM_EMAIL)).status, 200);
});
await check('sign-in by code does not reveal whether an email exists (or is staff)', async () => {
  const a = await anon.req('POST', '/api/auth/email/request', { email: `nobody-${stamp}@example.test` });
  const b = await anon.req('POST', '/api/auth/email/request', { email: ADMIN_EMAIL });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, a.status);
  assert.equal(b.text, a.text);
});

let newJobId;
await check('content manager creates a job; HTML is sanitized', async () => {
  const skills = (await anon.req('GET', '/api/skills')).json.data.skills;
  const r = await admin.req('POST', '/api/jobs', {
    title: `E2E test job ${stamp}`, jobScope: ['FullTime'], companyName: 'E2E Co', publishDate: new Date().toISOString(),
    citySymbol: 9000, description: '<p onclick="alert(1)">ok</p><script>alert(2)</script><a href="javascript:alert(3)">x</a><img src=x onerror=alert(4)>',
    uploadBy: 'e2e', status: 'Active', requiredSkills: [skills[0]._id], comments: '<b>internal</b><script>x</script>',
    isSponsored: false, isMarked: false, isSelfApply: false,
  });
  assert.equal(r.status, 200, r.text);
  const list = (await admin.req('GET', `/api/admin/jobs/with-comments?filterOptions[inputValue]=${encodeURIComponent('E2E test job ' + stamp)}`)).json.data;
  const job = list.jobs.find((j) => j.title === `E2E test job ${stamp}`);
  assert.ok(job, 'created job not found');
  newJobId = job._id;
  assert.ok(!/script|onclick|onerror|javascript:|<img/i.test(job.description), job.description);
  assert.ok(job.description.includes('<p>ok</p>'), job.description);
  assert.equal(job.comments, '<b>internal</b>');
});
await check('content manager sees comments on GET /jobs/:id and so does the admin; a visitor does not', async () => {
  const r = await admin.req('GET', `/api/jobs/${newJobId}`);
  assert.equal(r.json.data.comments, '<b>internal</b>');
  const a = await sysAdmin.req('GET', `/api/jobs/${newJobId}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.data.comments, '<b>internal</b>');
  assert.ok(!('comments' in (await anon.req('GET', `/api/jobs/${newJobId}`)).json.data));
});
await check('content manager edits the job', async () => {
  const r = await admin.req('PATCH', `/api/jobs/${newJobId}`, { title: `E2E edited ${stamp}`, status: 'Active' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await anon.req('GET', `/api/jobs/${newJobId}`)).json.data.title, `E2E edited ${stamp}`);
});
await check('new job appears in the page data and numeric link redirects', async () => {
  const job = (await anon.req('GET', `/api/jobs/${newJobId}`)).json.data;
  const page = await anon.req('GET', `/job/${newJobId}`);
  assert.ok(page.text.includes(`E2E edited ${stamp}`));
  const r = await anon.req('GET', `/job/${job.jobId}`);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), `/job/${newJobId}`);
});
await check('page data cannot break out of the script tag', async () => {
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { title: `</script><script>alert(1)</script> ${stamp}`, status: 'Active' });
  const page = await anon.req('GET', '/');
  assert.ok(!page.text.includes('</script><script>alert(1)'));
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { title: `E2E edited ${stamp}`, status: 'Active' });
});

// --- candidate ---
const token = crypto.randomUUID();
let userId;
await check('CV upload (PDF) works', async () => {
  const r = await upload(anon, token);
  assert.equal(r.status, 200, r.text);
});
await check('non-CV file type is rejected', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['MZ fake exe'], { type: 'application/pdf' }), 'cv.pdf');
  const r = await anon.req('POST', `/api/files/${crypto.randomUUID()}`, fd, true);
  assert.notEqual(r.status, 200);
});
await check('sign-up cannot set role=admin; CV is attached', async () => {
  const r = await signUp(user, {
    firstName: 'Eee', lastName: 'User', email: `e2e-${stamp}@example.test`, phoneNumber: `05${String(stamp).slice(-8)}`,
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000,
    skills: [], cvFileUrl: `${token}/cv_test.pdf`, hasAppliedToJob: false, consent: true, role: 'admin',
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.role, 'user');
  assert.equal(r.json.data.user.cvFileUrl, `post-scan/${token}/cv_test.pdf`);
  userId = r.json.data._id;
});
await check('a claimed CV cannot be claimed by another sign-up', async () => {
  const other = jar();
  const r = await signUp(other, {
    firstName: 'Eee', lastName: 'Other', email: `e2e-other-${stamp}@example.test`, phoneNumber: `03${String(stamp).slice(-7)}`,
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000,
    skills: [], cvFileUrl: `${token}/cv_test.pdf`, hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.user.cvFileUrl, '');
});
await check('anonymous cannot delete a claimed CV', async () => {
  const r = await anon.req('DELETE', `/api/files/?cvFileUrl=${encodeURIComponent(`${token}/cv_test.pdf`)}`);
  assert.notEqual(r.status, 200);
});
await check('user applies to a job and sees only own applications', async () => {
  const r = await user.req('POST', `/api/jobs/apply/${newJobId}`);
  assert.equal(r.status, 200, r.text);
  const mine = await user.req('GET', `/api/users/job-applications/${userId}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.data.total, 1);
  const dup = await user.req('POST', `/api/jobs/apply/${newJobId}`);
  assert.notEqual(dup.status, 200);
  const other = await user.req('GET', `/api/users/job-applications/${'c'.repeat(24)}`);
  assert.notEqual(other.status, 200);
});
await check('content manager lists candidates with applications and downloads the CV', async () => {
  const list = await admin.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(`e2e-${stamp}`)}`);
  assert.equal(list.status, 200, list.text);
  const u = list.json.data.users.find((x) => x._id === userId);
  assert.ok(u && !('password' in u));
  assert.equal(Object.keys(u.jobApplicationsToDisplay).length, 1);
  const f = await admin.req('GET', `/api/files/${userId}`);
  assert.equal(f.status, 200);
  assert.ok(f.text.startsWith('%PDF'));
  assert.ok(!list.json.data.users.some((x) => x.role !== 'user'), 'staff accounts in the candidates list');
});
await check('the admin also manages content: candidates, CV, applications, jobs — each hand-over logged as the admin', async () => {
  const list = await sysAdmin.req('GET', `/api/users?usersFilter[inputValue]=${encodeURIComponent(`e2e-${stamp}`)}`);
  assert.equal(list.status, 200, list.text);
  assert.ok(list.json.data.users.some((x) => x._id === userId));
  const f = await sysAdmin.req('GET', `/api/files/${userId}`);
  assert.equal(f.status, 200);
  assert.ok(f.text.startsWith('%PDF'));
  assert.equal((await sysAdmin.req('GET', `/api/users/job-applications/${userId}`)).status, 200);
  const jobs = await sysAdmin.req('GET', '/api/admin/jobs/with-comments');
  assert.equal(jobs.status, 200, jobs.text);
  assert.equal((await sysAdmin.req('GET', `/api/jobs/${newJobId}`)).json.data.comments, '<b>internal</b>', 'admin sees internal comments');
  const log = (await sysAdmin.req('GET', `/api/admin/audit?subject=${userId}&actor=${encodeURIComponent(ADMIN_EMAIL)}`)).json.data.entries;
  for (const a of ['candidates.shown', 'candidate.cv_opened', 'candidate.applications_viewed']) {
    assert.ok(log.some((e) => e.action === a && e.actor === ADMIN_EMAIL.toLowerCase()), `${a} by the admin not logged`);
  }
  assert.equal((await sysAdmin.req('GET', '/api/admin/security')).status, 200, 'the admin keeps the security screen');
});
await check('the admin manages staff: list has no candidates, role change is logged, last admin is protected', async () => {
  const st = (await sysAdmin.req('GET', '/api/admin/staff')).json.data;
  assert.ok(st.staff.every((x) => x.role !== 'user'));
  assert.ok(!st.staff.some((x) => x.email === `e2e-${stamp}@example.test`));
  const me = st.staff.find((x) => x.email === ADMIN_EMAIL.toLowerCase());
  const admins = st.staff.filter((x) => x.role === 'admin' && x.active).length;
  if (admins === 1) {
    assert.equal((await sysAdmin.req('PATCH', `/api/admin/staff/${me.id}/role`, { role: 'content_manager' })).status, 409);
  }
  assert.equal((await sysAdmin.req('POST', `/api/admin/staff/${me.id}/deactivate`)).status, 409);
  // Several roles per account (owner, 23.11.2026): a candidate's account gets the staff role ADDED and stays a candidate;
  // "remove access" takes only the staff role away.
  const p = await sysAdmin.req('POST', '/api/admin/staff', { email: `e2e-${stamp}@example.test`, role: 'content_manager' });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.data.created, false);
  assert.equal(p.json.data.alsoCandidate, true);
  const both = (await sysAdmin.req('GET', '/api/admin/staff')).json.data.staff.find((x) => x.email === `e2e-${stamp}@example.test`);
  assert.ok(both && both.role === 'content_manager' && both.alsoCandidate, JSON.stringify(both));
  assert.equal((await sysAdmin.req('PATCH', `/api/admin/staff/${both.id}/role`, { role: 'user' })).status, 200);
  assert.ok(!(await sysAdmin.req('GET', '/api/admin/staff')).json.data.staff.some((x) => x.email === `e2e-${stamp}@example.test`));
  // A new staff address: created without a password, role changes logged.
  const staffEmail = `e2e-staff-${stamp}@example.test`;
  const n = await sysAdmin.req('POST', '/api/admin/staff', { email: staffEmail, role: 'content_manager' });
  assert.equal(n.status, 200, n.text);
  assert.equal(n.json.data.created, true);
  const added = (await sysAdmin.req('GET', '/api/admin/staff')).json.data.staff.find((x) => x.email === staffEmail);
  assert.equal(added.role, 'content_manager');
  assert.equal((await sysAdmin.req('PATCH', `/api/admin/staff/${added.id}/role`, { role: 'user' })).status, 200);
  const log = (await sysAdmin.req('GET', `/api/admin/audit?action=staff.role_changed`)).json.data.entries;
  assert.ok(log.some((e) => e.target === staffEmail && e.details.to === 'user'));
  const invited = (await sysAdmin.req('GET', `/api/admin/audit?action=staff.invited`)).json.data.entries;
  assert.ok(invited.some((e) => e.target === staffEmail && e.details.role === 'content_manager'));
});

await check('user cannot list users, download CVs or open security (and is signed out for trying)', async () => {
  assert.notEqual((await user.req('GET', '/api/users')).status, 200);
  assert.notEqual((await user.req('GET', `/api/files/${userId}`)).status, 200);
  const u3 = jar();
  assert.equal((await candidateLogin(u3, `e2e-${stamp}@example.test`)).status, 200);
  assert.notEqual((await u3.req('GET', '/api/admin/staff')).status, 200);
});
// --- CV on apply (registered candidates) ---
const cvUser = jar();
const cvJobs = [];
let cvUserId;
await check('CV on apply: setup (4 jobs, a candidate with no CV)', async () => {
  for (let i = 0; i < 4; i++) {
    const title = `E2E cv job ${i} ${stamp}`;
    const r = await admin.req('POST', '/api/jobs', {
      title, jobScope: ['FullTime'], companyName: 'E2E Co', publishDate: new Date().toISOString(), citySymbol: 9000,
      description: '<p>cv</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [], isSponsored: false, isMarked: false, isSelfApply: false,
    });
    assert.equal(r.status, 200, r.text);
    const list = (await admin.req('GET', `/api/admin/jobs/with-comments?filterOptions[inputValue]=${encodeURIComponent(title)}`)).json.data;
    cvJobs.push(list.jobs.find((j) => j.title === title)._id);
  }
  const r = await signUp(cvUser, {
    firstName: 'Eee', lastName: 'Cv', email: `e2e-cv-${stamp}@example.test`, phoneNumber: `04${String(stamp).slice(-7)}`,
    dateOfBirth: '1990-01-01T00:00:00.000Z', gender: 'other', citySymbol: 9000, skills: [], hasAppliedToJob: false, consent: true,
  });
  assert.equal(r.status, 200, r.text);
  cvUserId = r.json.data._id; // sign-up also signs in
});
const myApplications = async () => {
  const r = await cvUser.req('GET', `/api/users/job-applications/${cvUserId}?filterOptions[limit]=20`);
  assert.equal(r.status, 200, r.text);
  return Object.fromEntries(r.json.data.jobs.map((j) => [j._id, j.applicationCv]));
};
await check('CV on apply: no CV on file -> /users/me/cv is null; upload + "update my profile CV"', async () => {
  const none = await cvUser.req('GET', '/api/users/me/cv');
  assert.equal(none.status, 200, none.text);
  assert.equal(none.json.data.cv, null);
  assert.equal((await cvUser.req('GET', '/api/users/me/cv/file')).status, 404);
  const t = crypto.randomUUID();
  assert.equal((await upload(cvUser, t, 'first_cv.pdf')).status, 200);
  const r = await cvUser.req('POST', `/api/jobs/apply/${cvJobs[0]}`, { cv: { mode: 'replaceProfile', cvFilePath: `${t}/first_cv.pdf` } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.profileCvFileUrl, `post-scan/${t}/first_cv.pdf`);
  const mine = await cvUser.req('GET', '/api/users/me/cv');
  assert.equal(mine.json.data.cv.fileName, 'first_cv.pdf');
  assert.ok(mine.json.data.cv.uploadedAt);
  const f = await cvUser.req('GET', '/api/users/me/cv/file');
  assert.equal(f.status, 200);
  assert.ok(f.text.startsWith('%PDF'));
});
await check('CV on apply: keep current CV', async () => {
  const r = await cvUser.req('POST', `/api/jobs/apply/${cvJobs[1]}`, { cv: { mode: 'profile' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.profileCvFileUrl, undefined);
});
await check('CV on apply: job-only CV leaves the profile CV unchanged', async () => {
  const t = crypto.randomUUID();
  assert.equal((await upload(cvUser, t, 'special_cv.pdf')).status, 200);
  const r = await cvUser.req('POST', `/api/jobs/apply/${cvJobs[2]}`, { cv: { mode: 'jobOnly', cvFilePath: `${t}/special_cv.pdf` } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await cvUser.req('GET', '/api/users/me/cv')).json.data.cv.fileName, 'first_cv.pdf');
});
await check('CV on apply: replacing the profile CV later does not change earlier applications', async () => {
  const t = crypto.randomUUID();
  assert.equal((await upload(cvUser, t, 'second_cv.pdf')).status, 200);
  const r = await cvUser.req('POST', `/api/jobs/apply/${cvJobs[3]}`, { cv: { mode: 'replaceProfile', cvFilePath: `${t}/second_cv.pdf` } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await cvUser.req('GET', '/api/users/me/cv')).json.data.cv.fileName, 'second_cv.pdf');
  const apps = await myApplications();
  assert.deepEqual(apps[cvJobs[0]], { fileName: 'first_cv.pdf', scope: 'profile' });
  assert.deepEqual(apps[cvJobs[1]], { fileName: 'first_cv.pdf', scope: 'profile' });
  assert.deepEqual(apps[cvJobs[2]], { fileName: 'special_cv.pdf', scope: 'job' });
  assert.deepEqual(apps[cvJobs[3]], { fileName: 'second_cv.pdf', scope: 'profile' });
});
await check('CV on apply: someone else\'s / an already used upload, or a bad choice, is refused', async () => {
  // `token` is the other candidate's CV (claimed at their sign-up)
  const r1 =await cvUser.req('POST', `/api/jobs/apply/${newJobId}`, { cv: { mode: 'jobOnly', cvFilePath: `${token}/cv_test.pdf` } });
  assert.notEqual(r1.status, 200);
  const r2 = await cvUser.req('POST', `/api/jobs/apply/${newJobId}`, { cv: { mode: 'nonsense' } });
  assert.notEqual(r2.status, 200);
  // the failed attempts did not create an application
  assert.equal((await myApplications())[newJobId], undefined);
});
await check('CV on apply: anonymous cannot read /users/me/cv', async () => {
  assert.notEqual((await anon.req('GET', '/api/users/me/cv')).status, 200);
  assert.notEqual((await anon.req('GET', '/api/users/me/cv/file')).status, 200);
});

// --- guest ---
await check('guest apply uses the job from the DB, cancels own pending upload', async () => {
  const g = jar();
  const t2 = crypto.randomUUID();
  assert.equal((await upload(g, t2, 'guest_cv.pdf')).status, 200);
  const del = await g.req('DELETE', `/api/files/?cvFileUrl=${encodeURIComponent(`${t2}/guest_cv.pdf`)}`);
  assert.equal(del.status, 200, del.text);
  const t3 = crypto.randomUUID();
  assert.equal((await upload(g, t3, 'guest_cv.pdf')).status, 200);
  const r = await g.req('POST', '/api/jobs/guestApply', {
    consent: true, jobData: { _id: newJobId, title: 'FAKE TITLE FROM BROWSER' },
    guestData: { fullName: 'Guest E2E', email: `guest-${stamp}@example.test`, phoneNumber: '0501111111', cvFilePath: `${t3}/guest_cv.pdf` },
  });
  assert.equal(r.status, 200, r.text);
});
await check('guest apply does not reveal whether an email has an account', async () => {
  const g = jar();
  const apply = (email) => g.req('POST', '/api/jobs/guestApply', {
    consent: true, jobData: { _id: newJobId }, guestData: { fullName: 'Guest E2E', email, phoneNumber: '0502222222' },
  });
  const registered = await apply(`e2e-${stamp}@example.test`);
  const unknown = await apply(`nobody-guest-${stamp}@example.test`);
  assert.equal(registered.status, 200, registered.text);
  assert.equal(registered.text, unknown.text);
});
// --- apply policy (site-wide defaults + per-job overrides) ---
// A new address each time: one quick application per address and job (a second one is answered like a new one, nothing stored).
let guestN = 0;
const guestApply = (g, extra = {}) => g.req('POST', '/api/jobs/guestApply', {
  consent: true, jobData: { _id: newJobId },
  guestData: { fullName: 'Guest Policy', email: `policy-${stamp}-${++guestN}@example.test`, phoneNumber: '0503333333', ...extra },
});
let originalDefaults;
await check('only admins read or change the apply-policy defaults', async () => {
  assert.notEqual((await anon.req('GET', '/api/admin/settings/apply-policy')).status, 200);
  assert.notEqual((await anon.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'none' })).status, 200);
  const r = await admin.req('GET', '/api/admin/settings/apply-policy');
  assert.equal(r.status, 200, r.text);
  originalDefaults = r.json.data;
  assert.equal(typeof originalDefaults.guestMode, 'string');
  assert.equal((await admin.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'no' })).status, 400);
  assert.equal((await admin.req('PUT', '/api/admin/settings/apply-policy', { other: true })).status, 400);
});
await check('a job inherits the defaults; the public payload shows the effective policy, not the overrides', async () => {
  await admin.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
  const job = (await anon.req('GET', `/api/jobs/${newJobId}`)).json.data;
  assert.deepEqual(job.applyPolicy, { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' });
  assert.equal(job.guestModeOverride, undefined);
  const adminJob = (await admin.req('GET', `/api/jobs/${newJobId}`)).json.data;
  assert.equal(adminJob.guestModeOverride, null);
  assert.equal(adminJob.quickCvOverride, null);
  assert.ok((await anon.req('GET', '/api/jobs/active')).json.data.jobs.every((j) => j.applyPolicy));
});
await check('default guest mode closed: guest apply is refused by the server', async () => {
  await admin.req('PUT', '/api/admin/settings/apply-policy', { guestMode: 'none' });
  assert.equal((await anon.req('GET', `/api/jobs/${newJobId}`)).json.data.applyPolicy.guestMode, 'none');
  const r = await guestApply(jar());
  assert.equal(r.status, 400);
  assert.equal(r.json?.code, 'jb10');
});
await check('per-job override on beats the default off; sync-style edits keep it', async () => {
  const p = await admin.req('PATCH', `/api/jobs/${newJobId}`, { guestModeOverride: 'quick', status: 'Active' });
  assert.equal(p.status, 200, p.text);
  // An edit that does not mention the overrides (e.g. the status toggle) leaves them alone.
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { title: `E2E edited ${stamp}`, status: 'Active' });
  assert.equal((await admin.req('GET', `/api/jobs/${newJobId}`)).json.data.guestModeOverride, 'quick');
  const r = await guestApply(jar());
  assert.equal(r.status, 200, r.text);
});
await check('CV required: a guest application without a (claimable) CV is refused', async () => {
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { quickCvOverride: 'required', status: 'Active' });
  assert.equal((await anon.req('GET', `/api/jobs/${newJobId}`)).json.data.applyPolicy.quickCv, 'required');
  const g = jar();
  const noCv = await guestApply(g);
  assert.equal(noCv.status, 400);
  assert.equal(noCv.json?.code, 'jb11');
  const bogus = await guestApply(g, { cvFilePath: `${crypto.randomUUID()}/not_uploaded.pdf` });
  assert.equal(bogus.json?.code, 'jb11');
  const t4 = crypto.randomUUID();
  assert.equal((await upload(g, t4, 'policy_cv.pdf')).status, 200);
  const withCv = await guestApply(g, { cvFilePath: `${t4}/policy_cv.pdf` });
  assert.equal(withCv.status, 200, withCv.text);
});
await check('override back to inherit (null) follows the default again', async () => {
  const p = await admin.req('PATCH', `/api/jobs/${newJobId}`, { guestModeOverride: null, quickCvOverride: null, status: 'Active' });
  assert.equal(p.status, 200, p.text);
  const r = await guestApply(jar());
  assert.equal(r.json?.code, 'jb10');
});
await check('registered users can still apply when the guest mode is closed', async () => {
  const u3 = jar();
  assert.equal((await candidateLogin(u3, `e2e-${stamp}@example.test`)).status, 200);
  // A job made on this site that inherits the default (quick apply off); the registered path is not affected.
  // (Not a board job picked at random: the existing site's jobs take no applications here, 409 job_on_existing_site.)
  const title = `E2E inherit job ${stamp}`;
  const c = await admin.req('POST', '/api/jobs', {
    title, jobScope: ['FullTime'], companyName: 'E2E Co', publishDate: new Date().toISOString(), citySymbol: 9000,
    description: '<p>inherit</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [], isSponsored: false, isMarked: false, isSelfApply: false,
  });
  assert.equal(c.status, 200, c.text);
  const inherit = (await admin.req('GET', `/api/admin/jobs/with-comments?filterOptions[inputValue]=${encodeURIComponent(title)}`)).json.data.jobs.find((j) => j.title === title);
  assert.equal(inherit.onExistingSite, false);
  const r = await u3.req('POST', `/api/jobs/apply/${inherit._id}`);
  assert.equal(r.status, 200, r.text);
});
if (originalDefaults) await admin.req('PUT', '/api/admin/settings/apply-policy', originalDefaults);

await check('logout invalidates the session', async () => {
  const u2 = jar();
  assert.equal((await candidateLogin(u2, `e2e-${stamp}@example.test`)).status, 200);
  assert.equal((await u2.req('GET', `/api/users/job-applications/${userId}`)).status, 200);
  await u2.req('POST', '/api/logout');
  assert.notEqual((await u2.req('GET', `/api/users/job-applications/${userId}`)).status, 200);
});

// ---- public read-only API (/api/public/v1) and MCP server (/mcp) ----
const PUB = '/api/public/v1';
const JOB_KEYS = ['applyContact', 'applyMode', 'companyName', 'description', 'externalLink', 'extraFields', 'id', 'isPinned', 'isSponsored', 'jobNumber', 'jobScope', 'location', 'publishDate', 'skills', 'thresholdCondition', 'title', 'url'];
const LOC_KEYS = ['city', 'citySymbol', 'district', 'lat', 'lng'];
const keysOf = (o) => Object.keys(o).sort();
const assertPublicJob = (j, extra = []) => {
  assert.deepEqual(keysOf(j), [...JOB_KEYS, ...extra].sort(), `job keys: ${keysOf(j)}`);
  if (j.location) assert.deepEqual(keysOf(j.location), LOC_KEYS);
  for (const s of j.skills) assert.deepEqual(keysOf(s), ['id', 'name']);
};
const mcp = async (id, method, params) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return r.json();
};
const mcpTool = async (name, args) => {
  const r = await mcp(9, 'tools/call', { name, arguments: args });
  return { isError: r.result?.isError, data: r.result?.isError ? null : JSON.parse(r.result.content[0].text), raw: r };
};

await check('public API: every endpoint returns exactly the allowlisted keys', async () => {
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { status: 'Active', comments: `internal ${stamp}`, contactPersonEmail: `contact-${stamp}@example.test` });
  const list = await anon.req('GET', `${PUB}/jobs?limit=100`);
  assert.equal(list.status, 200);
  assert.deepEqual(keysOf(list.json), ['data', 'limit', 'page', 'total']);
  assert.ok(list.json.data.length > 0 && list.json.data.length <= 100);
  list.json.data.forEach((j) => assertPublicJob(j));
  assert.match(list.headers.get('cache-control'), /^public, max-age=/);
  assert.ok(list.headers.get('etag'));
  assert.equal(list.headers.get('access-control-allow-origin'), '*');
  const one = await anon.req('GET', `${PUB}/jobs/${newJobId}`);
  assert.equal(one.status, 200);
  assert.deepEqual(keysOf(one.json), ['data']);
  assertPublicJob(one.json.data);
  assert.ok(!one.text.includes(`internal ${stamp}`) && !one.text.includes(`contact-${stamp}`), 'comments / contact leaked');
  const byNumber = await anon.req('GET', `${PUB}/jobs/${one.json.data.jobNumber}`);
  assert.equal(byNumber.json.data.id, newJobId);
  const near = await anon.req('GET', `${PUB}/jobs/near?lat=32.0853&lng=34.7818&radiusKm=100&limit=50`);
  assert.equal(near.status, 200);
  assert.deepEqual(keysOf(near.json), ['data', 'limit', 'page', 'remote', 'total', 'withoutCoordinates']);
  near.json.data.forEach((j) => assertPublicJob(j, ['distanceKm']));
  for (let i = 1; i < near.json.data.length; i++) assert.ok(near.json.data[i].distanceKm >= near.json.data[i - 1].distanceKm);
  const locs = await anon.req('GET', `${PUB}/locations`);
  assert.ok(locs.json.data.length > 100);
  locs.json.data.forEach((l) => assert.deepEqual(keysOf(l), LOC_KEYS));
  const skills = await anon.req('GET', `${PUB}/skills`);
  skills.json.data.forEach((s) => assert.deepEqual(keysOf(s), ['id', 'name']));
  assert.equal((await anon.req('GET', `${PUB}/jobs?limit=101`)).status, 400);
  const etag = list.headers.get('etag');
  const cached = await fetch(`${BASE}${PUB}/jobs?limit=100`, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
  assert.equal(cached.status, 304);
});

await check('public API: filters (text, location, skills, distance) and paging', async () => {
  const one = (await anon.req('GET', `${PUB}/jobs/${newJobId}`)).json.data;
  const byText = await anon.req('GET', `${PUB}/jobs?q=${encodeURIComponent(`E2E edited ${stamp}`)}`);
  assert.ok(byText.json.data.some((j) => j.id === newJobId));
  const byLoc = await anon.req('GET', `${PUB}/jobs?location=${one.location.citySymbol}&limit=100`);
  assert.ok(byLoc.json.data.every((j) => [one.location.citySymbol, -1, -2].includes(j.location?.citySymbol)));
  const byName = await anon.req('GET', `${PUB}/jobs?location=${encodeURIComponent(one.location.city)}&limit=100`);
  assert.equal(byName.json.total, byLoc.json.total);
  assert.equal((await anon.req('GET', `${PUB}/jobs?location=NoSuchPlaceXyz`)).status, 400);
  const withSkill = (await anon.req('GET', `${PUB}/jobs?limit=100`)).json.data.find((j) => j.skills.length);
  if (withSkill) {
    const s = withSkill.skills[0];
    const r = await anon.req('GET', `${PUB}/jobs?skills=${s.id}&limit=100`);
    assert.ok(r.json.data.length && r.json.data.every((j) => j.skills.some((x) => x.id === s.id)));
    const byName2 = await anon.req('GET', `${PUB}/jobs?skills=${encodeURIComponent(s.name)}&limit=100`);
    assert.ok(byName2.json.total >= r.json.total);
  }
  const p1 = (await anon.req('GET', `${PUB}/jobs?limit=2&page=1`)).json;
  const p2 = (await anon.req('GET', `${PUB}/jobs?limit=2&page=2`)).json;
  if (p1.total > 2) assert.notEqual(p1.data[0].id, p2.data[0].id);
  const dist = await anon.req('GET', `${PUB}/jobs?lat=32.0853&lng=34.7818&radiusKm=30`);
  dist.json.data.forEach((j) => assert.ok(j.distanceKm <= 30));
});

await check('public API: only GET; site API stays closed to other sites', async () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await anon.req(m, `${PUB}/jobs`, { title: 'x' })).status, 405);
    assert.equal((await anon.req(m, `${PUB}/jobs/${newJobId}`, { title: 'x' })).status, 405);
  }
  const cross = await fetch(`${BASE}${PUB}/jobs?limit=1`, { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' } });
  assert.equal(cross.status, 200);
  const siteCross = await fetch(`${BASE}/api/jobs/active`, { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' } });
  assert.equal(siteCross.status, 403, 'the site API must still refuse cross-site requests');
  // Cookies are ignored: an admin session sees the same public shape, never comments.
  const asAdmin = await admin.req('GET', `${PUB}/jobs/${newJobId}`);
  assertPublicJob(asAdmin.json.data);
  assert.ok(!asAdmin.text.includes(`internal ${stamp}`));
  assert.ok((await anon.req('GET', `${PUB}/openapi.json`)).json.paths['/jobs']);
});

await check('public API + MCP: a suspended or closed job never appears', async () => {
  for (const status of ['Suspended', 'Closed']) {
    await admin.req('PATCH', `/api/jobs/${newJobId}`, { status });
    assert.equal((await anon.req('GET', `${PUB}/jobs/${newJobId}`)).status, 404, status);
    const all = await anon.req('GET', `${PUB}/jobs?limit=100&q=${encodeURIComponent(`E2E edited ${stamp}`)}`);
    assert.ok(!all.json.data.some((j) => j.id === newJobId), `${status} job listed`);
    const near = await anon.req('GET', `${PUB}/jobs/near?lat=32.0853&lng=34.7818&radiusKm=200&limit=100`);
    assert.ok(!near.json.data.some((j) => j.id === newJobId));
    assert.equal((await mcpTool('get_job', { id: newJobId })).isError, true);
    const s = await mcpTool('search_jobs', { query: `E2E edited ${stamp}` });
    assert.ok(!s.data.data.some((j) => j.id === newJobId));
  }
  await admin.req('PATCH', `/api/jobs/${newJobId}`, { status: 'Active' });
  assert.equal((await anon.req('GET', `${PUB}/jobs/${newJobId}`)).status, 200);
});

await check('MCP: initialize, exactly the read-only tools, tools return public shapes', async () => {
  const init = await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'skeelz-jobs');
  const { result } = await mcp(2, 'tools/list', {});
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['get_job', 'jobs_near', 'list_locations', 'list_skills', 'search_jobs']);
  assert.ok(result.tools.every((t) => t.annotations.readOnlyHint === true));
  const s = await mcpTool('search_jobs', { query: `E2E edited ${stamp}`, limit: 5 });
  assert.ok(s.data.data.some((j) => j.id === newJobId));
  s.data.data.forEach((j) => assertPublicJob(j));
  const g = await mcpTool('get_job', { id: newJobId });
  assertPublicJob(g.data);
  assert.ok(!JSON.stringify(g.raw).includes(`internal ${stamp}`));
  const n = await mcpTool('jobs_near', { lat: 32.0853, lng: 34.7818, radiusKm: 50, limit: 5 });
  n.data.data.forEach((j) => assertPublicJob(j, ['distanceKm']));
  const l = await mcpTool('list_locations', { search: 'תל אביב' });
  assert.ok(l.data.data.length >= 1);
  assert.ok(Array.isArray((await mcpTool('list_skills', {})).data.data));
  assert.equal((await mcpTool('jobs_near', { lat: 48.8, lng: 2.3, radiusKm: 5 })).isError, true);
  assert.equal((await fetch(BASE + '/mcp')).status, 405);
});

await check('headers: personal answers are no-store, public lists keep their caching; Permissions-Policy; no jsdelivr in the CSP', async () => {
  const active = await fetch(`${BASE}/api/jobs/active`);
  assert.doesNotMatch(active.headers.get('cache-control') || '', /no-store/, 'the public job list lost its caching');
  const session = await fetch(`${BASE}/api/auth/session`);
  assert.match(session.headers.get('cache-control') || '', /private, no-store/);
  const one = await fetch(`${BASE}/api/jobs/${newJobId}`);
  assert.match(one.headers.get('cache-control') || '', /no-store/);
  const page = await fetch(`${BASE}/`);
  assert.equal(page.headers.get('permissions-policy'), 'geolocation=(self), camera=(), microphone=(), payment=()');
  assert.ok(!(page.headers.get('content-security-policy') || '').includes('jsdelivr'));
});

// cleanup: close the test job so it disappears from the public list
await admin.req('PATCH', `/api/jobs/${newJobId}`, { status: 'Closed' });
for (const id of cvJobs) await admin.req('PATCH', `/api/jobs/${id}`, { status: 'Closed' });

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
