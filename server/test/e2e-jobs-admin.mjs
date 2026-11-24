// End-to-end checks for the jobs-management screen (docs/jobs-management.md) against a local server:
// pin and bump order on every public listing, the pinned mark (isPinned), not-Active / scheduled / archived jobs hidden from the public API and MCP,
// soft delete + restore (applications kept), publish-date validation, integrations can't overwrite the board,
// jobs imported from the existing site read-only (every change 409 job_read_only),
// the admin allowed too (an admin can do everything a content manager can), anonymous refused, activity log entries.
//   BASE=http://localhost:3100 node test/e2e-jobs-admin.mjs     (staff sign in through the mock xhostd SSO)
// Never point this at production.
import assert from 'node:assert/strict';
import { ensureImportedJob, isSkip, skip, summary } from './helpers/localDb.mjs';
import { staffLogin } from './helpers/staffLogin.mjs';
import { signUp, candidateLogin } from './helpers/candidate.mjs';

const BASE = process.env.BASE || 'http://localhost:3100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE !== 'true') {
  throw new Error('e2e writes data: run it against localhost only');
}
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
const CM_EMAIL = process.env.CM_EMAIL || 'content@example.test';
const PUB = '/api/public/v1';

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
  catch (e) { results.push([isSkip(e) ? 'SKIP' : 'FAIL', name, e.message]); }
};

const mcpTool = async (name, args) => {
  const r = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  return { isError: j.result?.isError, data: j.result?.isError ? null : JSON.parse(j.result.content[0].text) };
};

const anon = jar();
const cm = jar();     // content manager: jobs
const admin = jar();  // admin: security + everything a content manager does
const stamp = Date.now();
const day = 86_400_000;

assert.equal((await staffLogin(cm, CM_EMAIL)).status, 200, 'content manager sign-in (mock xhostd SSO)');
assert.equal((await staffLogin(admin, ADMIN_EMAIL)).status, 200, 'admin sign-in (mock xhostd SSO)');

const skills = (await anon.req('GET', '/api/skills')).json.data;
const skillId = (skills.skills ?? skills)[0]._id;
const created = [];
const createJob = async (title, extra = {}) => {
  const r = await cm.req('POST', '/api/jobs', {
    title, jobScope: ['FullTime'], companyName: 'E2E Board Co', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, isSelfApply: true, ...extra,
  });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.data.id, 'create returns the id');
  created.push(r.json.data.id);
  return r.json.data.id;
};
const tag = `E2EBOARD${stamp}`;
// Old publish date (bottom of the board), one public, one to suspend, one to schedule.
const old = new Date(Date.now() - 300 * day).toISOString();
const A = await createJob(`${tag} A`, { publishDate: old });
const B = await createJob(`${tag} B`, { publishDate: old });
const P = await createJob(`${tag} Suspended`);
const S = await createJob(`${tag} Scheduled`);

const boardIds = async () => (await anon.req('GET', '/api/jobs/active')).json.data.jobs.map((j) => j._id);
const apiIds = async () => (await anon.req('GET', `${PUB}/jobs?limit=100`)).json.data.map((j) => j.id);
const nearIds = async () => (await anon.req('GET', '/api/jobs/near?lat=32.0853&lng=34.7818&radiusKm=50')).json.data.jobs.map((j) => j._id);
const apiNearIds = async () => (await anon.req('GET', `${PUB}/jobs/near?lat=32.0853&lng=34.7818&radiusKm=50&limit=100`)).json.data.map((j) => j.id);
const mcpIds = async () => (await mcpTool('search_jobs', { limit: 100 })).data.data.map((j) => j.id);
const mcpNearIds = async () => (await mcpTool('jobs_near', { lat: 32.0853, lng: 34.7818, radiusKm: 50, limit: 100 })).data.data.map((j) => j.id);
const boardWithHotIds = async () => (await anon.req('GET', '/api/jobs/active?filterOptions[includeRandomSponsoredJobs]=true')).json.data.jobs.map((j) => j._id);
const listings = { board: boardIds, boardWithHot: boardWithHotIds, map: nearIds, publicApi: apiIds, publicApiNear: apiNearIds, mcp: mcpIds, mcpNear: mcpNearIds };

await check('the admin may use jobs management too (logged as the admin); anonymous is refused on every route', async () => {
  for (const [m, p] of [['POST', `/api/admin/jobs/${A}/pin`], ['POST', `/api/admin/jobs/${A}/bump`], ['DELETE', `/api/admin/jobs/${A}/pin`], ['PATCH', `/api/admin/jobs/${A}/board`],
    ['POST', `/api/admin/jobs/${A}/archive`], ['POST', `/api/admin/jobs/${A}/restore`], ['GET', `/api/admin/jobs/${A}/applications-count`],
    ['GET', '/api/admin/jobs/with-comments']]) {
    const a = await anon.req(m, p, m === 'PATCH' ? { status: 'Suspended' } : undefined);
    assert.notEqual(a.status, 200, `anonymous ${m} ${p} answered 200`);
    assert.equal(a.json?.code, 'au2', `anonymous ${m} ${p}: ${a.text}`);
  }
  assert.equal((await admin.req('GET', '/api/admin/jobs/with-comments')).status, 200);
  assert.equal((await admin.req('GET', `/api/admin/jobs/${A}/applications-count`)).status, 200);
  assert.equal((await admin.req('POST', `/api/admin/jobs/${A}/pin`)).status, 200, 'admin pin');
  assert.equal((await admin.req('DELETE', `/api/admin/jobs/${A}/pin`)).status, 200, 'admin unpin');
  const log = (await admin.req('GET', `/api/admin/audit?subject=${A}&action=job.`)).json.data.entries;
  assert.ok(log.some((e) => e.action === 'job.pinned' && e.actor === ADMIN_EMAIL.toLowerCase()), 'admin pin not logged as the admin');
  const job = (await cm.req('GET', `/api/jobs/${A}`)).json.data;
  assert.ok(!job.pinnedAt && job.status === 'Active', 'back as it was');
});

await check('pin order: pin B, then A → A first, B second (latest pin on top) on board, map, public API and MCP', async () => {
  assert.equal((await cm.req('POST', `/api/admin/jobs/${B}/pin`)).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const r = await cm.req('POST', `/api/admin/jobs/${A}/pin`);
  assert.equal(r.status, 200);
  assert.ok(r.json.data.pinnedAt, 'pinnedAt returned');
  for (const [name, f] of Object.entries(listings)) {
    const ids = await f();
    assert.deepEqual(ids.slice(0, 2), [A, B], `${name}: pinned jobs first, latest pin on top (got ${ids.slice(0, 3).join(',')})`);
  }
  // Pinning a pinned job again changes nothing; bumping a pinned job moves it above the other pins.
  assert.equal((await cm.req('POST', `/api/admin/jobs/${B}/pin`)).status, 200);
  for (const [name, f] of Object.entries(listings)) assert.deepEqual((await f()).slice(0, 2), [A, B], `${name} after pin again`);
  const bumped = await cm.req('POST', `/api/admin/jobs/${B}/bump`);
  assert.equal(bumped.status, 200, bumped.text);
  assert.equal(bumped.json.data.bumpedAt, null, 'a bump on a pinned job only reorders the pins');
  for (const [name, f] of Object.entries(listings)) assert.deepEqual((await f()).slice(0, 2), [B, A], `${name} after bumping pinned B`);
});

await check('pinned mark: isPinned in the public API and MCP, pinnedAt on the board', async () => {
  const api = (await anon.req('GET', `${PUB}/jobs?limit=100`)).json.data;
  assert.deepEqual(api.filter((j) => j.isPinned).map((j) => j.id), [B, A]);
  assert.equal((await anon.req('GET', `${PUB}/jobs/${A}`)).json.data.isPinned, true);
  assert.equal((await mcpTool('get_job', { id: B })).data.isPinned, true);
  const board = (await anon.req('GET', '/api/jobs/active')).json.data.jobs;
  assert.ok(board[0].pinnedAt && board[1].pinnedAt && !board[2].pinnedAt, 'the board marks the two pinned jobs');
});

await check('after the pins: the rest by publish date, newest first (board + public API)', async () => {
  const jobs = (await anon.req('GET', `${PUB}/jobs?limit=100`)).json.data;
  const rest = jobs.slice(2);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1].publishDate >= rest[i].publishDate, `order broken at ${i}`);
  // A request for another order is ignored on the public board.
  const board = (await anon.req('GET', '/api/jobs/active?filterOptions[sortField]=title&filterOptions[sortOrder]=asc')).json.data.jobs;
  assert.deepEqual(board.slice(0, 2).map((j) => j._id), [B, A]);
});

await check('unpin: back to publish-date order', async () => {
  assert.equal((await cm.req('DELETE', `/api/admin/jobs/${B}/pin`)).status, 200);
  for (const [name, f] of Object.entries(listings)) {
    const ids = await f();
    assert.equal(ids[0], A, `${name}: A still pinned on top`);
    assert.notEqual(ids[1], B, `${name}: B is no longer second (it is an old job)`);
  }
  assert.equal((await cm.req('DELETE', `/api/admin/jobs/${A}/pin`)).status, 200);
  assert.ok(!(await boardIds()).slice(0, 2).includes(A));
  assert.equal((await anon.req('GET', `${PUB}/jobs/${A}`)).json.data.isPinned, false);
});

await check('bump: an old job goes to the top once (board, public API, MCP); a newer job goes above it later', async () => {
  // (Not boardWithHot: the board's two random hot jobs always sit right after the pins, above the rest.)
  const listed = { board: boardIds, publicApi: apiIds, mcp: mcpIds };
  const r = await cm.req('POST', `/api/admin/jobs/${A}/bump`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.data.bumpedAt, 'bumpedAt set');
  assert.equal(r.json.data.pinnedAt, null, 'a bump does not pin');
  for (const [name, f] of Object.entries(listed)) assert.equal((await f())[0], A, `${name}: bumped A on top`);
  assert.equal((await anon.req('GET', `${PUB}/jobs/${A}`)).json.data.isPinned, false);
  // Wait, so the new job's publish date is clearly after the bump (the bump uses the DB clock, the
  // publish date the test's clock: leave a margin of seconds, not milliseconds).
  await new Promise((r) => setTimeout(r, 2500));
  const N = await createJob(`E2EBUMPNEWER${stamp}`, { publishDate: new Date().toISOString() }); // outside `tag`: later checks list the tag's archive
  for (const [name, f] of Object.entries(listed)) assert.deepEqual((await f()).slice(0, 2), [N, A], `${name}: the newer job above the bumped one`);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${N}/archive`)).status, 200);
});

await check('status is the only switch: a Suspended job is hidden everywhere (lists, API, MCP, direct link); no private flag', async () => {
  assert.ok((await boardIds()).includes(P), 'Active = on the board');
  const r = await cm.req('PATCH', `/api/admin/jobs/${P}/board`, { status: 'Suspended' });
  assert.equal(r.status, 200, r.text);
  assert.ok(!('isPublic' in r.json.data), 'no isPublic in the job any more');
  for (const [name, f] of Object.entries(listings)) assert.ok(!(await f()).includes(P), `${name} shows the suspended job`);
  assert.equal((await anon.req('GET', `${PUB}/jobs/${P}`)).status, 404);
  assert.equal((await mcpTool('get_job', { id: P })).isError, true);
  assert.equal((await mcpTool('search_jobs', { query: `${tag} Suspended` })).data.data.length, 0);
  assert.equal((await anon.req('GET', `/api/jobs/${P}`)).status, 404, 'no "unlisted" jobs: the direct link is closed too');
  assert.equal((await cm.req('GET', `/api/jobs/${P}`)).status, 200, 'content manager sees it');
  const staff = (await cm.req('GET', `/api/admin/jobs/with-comments?filterOptions[jobStatus]=Suspended&filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs;
  assert.deepEqual(staff.map((j) => j._id), [P]);
  // Pinning a suspended job does not put it on the board.
  await cm.req('POST', `/api/admin/jobs/${P}/pin`);
  assert.ok(!(await boardIds()).includes(P));
  await cm.req('DELETE', `/api/admin/jobs/${P}/pin`);
  // The retired private flag is not editable on the screen.
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${P}/board`, { isPublic: false })).json.code, 'bad_field');
  // Active again: back everywhere.
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${P}/board`, { status: 'Active' })).status, 200);
  for (const [name, f] of Object.entries(listings)) assert.ok((await f()).includes(P), `${name} misses the job after it is Active again`);
});

await check('publish date: a future date needs scheduling; scheduled = hidden until then; far future refused', async () => {
  const future = new Date(Date.now() + 3 * day).toISOString();
  const no = await cm.req('PATCH', `/api/admin/jobs/${S}/board`, { publishDate: future });
  assert.equal(no.status, 400);
  assert.equal(no.json.code, 'publish_date_future_needs_schedule');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${S}/board`, { publishDate: new Date(Date.now() + 400 * day).toISOString(), schedulePublish: true })).json.code, 'publish_date_too_far');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${S}/board`, { publishDate: 'yesterday' })).status, 400);
  const ok = await cm.req('PATCH', `/api/admin/jobs/${S}/board`, { publishDate: future, schedulePublish: true });
  assert.equal(ok.status, 200, ok.text);
  for (const [name, f] of Object.entries(listings)) assert.ok(!(await f()).includes(S), `${name} shows the scheduled job`);
  assert.equal((await anon.req('GET', `/api/jobs/${S}`)).status, 404, 'scheduled job page hidden from the public');
  assert.equal((await cm.req('GET', `/api/jobs/${S}`)).status, 200, 'content manager sees it');
  const sched = (await cm.req('GET', `/api/admin/jobs/with-comments?filterOptions[scheduled]=true&filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs;
  assert.deepEqual(sched.map((j) => j._id), [S]);
  // Back to today: public again.
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${S}/board`, { publishDate: new Date().toISOString() })).status, 200);
  assert.ok((await boardIds()).includes(S));
  // The full form validates too.
  const form = await cm.req('PATCH', `/api/jobs/${S}`, { status: 'Active', publishDate: future });
  assert.equal(form.status, 400);
  assert.equal(form.json.code, 'publish_date_future_needs_schedule');
});

await check('inline edits: crown, status, apply-policy overrides; unknown fields refused', async () => {
  const r = await cm.req('PATCH', `/api/admin/jobs/${A}/board`, { isSponsored: true, guestModeOverride: 'none', quickCvOverride: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.isSponsored, true);
  assert.equal(r.json.data.guestModeOverride, 'none');
  assert.equal(r.json.data.isSelfApply, false, 'isSelfApply follows the guest mode');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${A}/board`, { guestModeOverride: 'open' })).status, 400);
  const pubA = (await anon.req('GET', `${PUB}/jobs/${A}`)).json.data;
  assert.equal(pubA.isSponsored, true, 'crown shown publicly');
  for (const k of ['pinnedAt', 'deletedAt', 'managedFields']) assert.ok(!(k in pubA), `${k} leaked to the public API`);
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${A}/board`, { title: 'hacked' })).json.code, 'bad_field');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${A}/board`, { isSponsored: 'no' })).status, 400);
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${A}/board`, { status: 'Deleted' })).status, 400);
  const sp = (await cm.req('GET', `/api/admin/jobs/with-comments?filterOptions[isSponsored]=true&filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs;
  assert.deepEqual(sp.map((j) => j._id), [A]);
});

await check('integrations (internal API) cannot overwrite board fields set on the screen', async () => {
  // A job edited on the screen has isSponsored in managed_fields (set above).
  const j = (await cm.req('GET', `/api/jobs/${A}`)).json.data;
  assert.ok(j.managedFields.includes('isSponsored'), JSON.stringify(j.managedFields));
  const mint = await admin.req('POST', '/api/admin/api-tokens', { name: `e2e board ${stamp}`, scopes: ['jobs:read', 'jobs:write'], expiresInDays: 1 });
  assert.equal(mint.status, 201, mint.text);
  const token = mint.json.data.token;
  const call = (method, path, body) => fetch(BASE + '/api/internal/v1' + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  // Like a Salesforce flow: resend the sponsored flag, a publish date and the comments.
  const r = await call('PATCH', `/jobs/${A}`, { status: 'Active', isSponsored: false, comments: `from integration ${stamp}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.ignored, ['isSponsored']);
  assert.equal(r.json.data.isSponsored, true, 'screen value kept');
  assert.equal(r.json.data.comments, `from integration ${stamp}`, 'other fields still update');
  // Pin / bump / archive are never taken from an integration; the retired isPublic is dropped (can't hide a job).
  assert.equal((await call('PATCH', `/jobs/${A}`, { status: 'Active', isPublic: false })).json.ignored?.includes('isPublic'), true);
  assert.ok((await boardIds()).includes(A), 'still on the board');
  // A job created by the integration and never touched on the screen: the integration may set the crown.
  const c = await call('POST', '/jobs', {
    title: `${tag} Integration`, jobScope: ['FullTime'], companyName: 'E2E Board Co', publishDate: new Date(Date.now() - 1000).toISOString(),
    citySymbol: 5000, description: '<p>e2e</p>', uploadBy: 'e2e', status: 'Active', requiredSkills: [skillId],
    isSponsored: false, isMarked: false, isSelfApply: true, isPublic: false,
  });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  created.push(c.json.data._id);
  assert.ok(!('isPublic' in c.json.data), 'no private flag');
  const r2 = await call('PATCH', `/jobs/${c.json.data._id}`, { status: 'Active', isSponsored: true });
  assert.deepEqual(r2.json.ignored, []);
  assert.equal(r2.json.data.isSponsored, true);
  // Revoke the token.
  await admin.req('POST', `/api/admin/api-tokens/${mint.json.data.id}/revoke`);
});

await check('soft delete: hidden everywhere, applications kept, restore brings it back as it was', async () => {
  // A candidate applies to B (registered), so B has an application.
  const user = jar();
  const phone = `05${String(stamp).slice(-8)}`;
  const email = `board-${stamp}@example.test`;
  const su = await signUp(user, {
    firstName: 'Eee', lastName: 'Board', email, phoneNumber: phone, citySymbol: 9000,
    gender: 'other', dateOfBirth: '1990-01-01T00:00:00.000Z', skills: [], cvFileUrl: '', hasAppliedToJob: false, consent: true,
  });
  assert.equal(su.status, 200, su.text);
  assert.equal((await user.req('POST', `/api/jobs/apply/${B}`)).status, 200, 'candidate applied');
  const before = (await cm.req('GET', `/api/admin/jobs/${B}/applications-count`)).json.data.count;
  assert.equal(before, 1);
  await cm.req('PATCH', `/api/admin/jobs/${B}/board`, { isSponsored: true });
  await cm.req('POST', `/api/admin/jobs/${B}/pin`);
  const del = await cm.req('POST', `/api/admin/jobs/${B}/archive`);
  assert.equal(del.status, 200, del.text);
  assert.ok(del.json.data.deletedAt);
  for (const [name, f] of Object.entries(listings)) assert.ok(!(await f()).includes(B), `${name} shows the archived job`);
  assert.equal((await anon.req('GET', `/api/jobs/${B}`)).status, 404);
  assert.equal((await anon.req('GET', `${PUB}/jobs/${B}`)).status, 404);
  assert.equal((await mcpTool('get_job', { id: B })).isError, true);
  assert.equal((await cm.req('POST', `/api/admin/jobs/${B}/archive`)).status, 404, 'archiving twice');
  assert.equal((await cm.req('POST', `/api/admin/jobs/${B}/pin`)).status, 404, 'an archived job cannot be pinned');
  assert.ok((await user.req('POST', `/api/jobs/apply/${B}`)).status >= 400, 'no applying to an archived job');
  const live = (await cm.req('GET', `/api/admin/jobs/with-comments?filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs.map((j) => j._id);
  assert.ok(!live.includes(B), 'staff default view hides the archive');
  const arch = (await cm.req('GET', `/api/admin/jobs/with-comments?filterOptions[archived]=only&filterOptions[inputValue]=${encodeURIComponent(tag)}`)).json.data.jobs.map((j) => j._id);
  assert.deepEqual(arch, [B]);
  assert.equal((await cm.req('GET', `/api/admin/jobs/${B}/applications-count`)).json.data.count, before, 'applications kept');
  const res = await cm.req('POST', `/api/admin/jobs/${B}/restore`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.deletedAt, null);
  assert.equal(res.json.data.isSponsored, true, 'restored as it was (crown)');
  assert.equal(res.json.data.status, 'Active');
  assert.equal(res.json.data.pinnedAt, null, 'the pin is cleared by the archive');
  assert.ok((await boardIds()).includes(B));
  assert.equal((await cm.req('POST', `/api/admin/jobs/${B}/restore`)).status, 404, 'restoring twice');
});

await check('jobs imported from the existing site are read-only: every change refused (409), still public; new jobs editable', async () => {
  await ensureImportedJob(); // with DATABASE_URL: seeds one on a fresh DB (helpers/localDb.mjs)
  const all = (await cm.req('GET', '/api/admin/jobs/with-comments')).json.data;
  const list = Array.isArray(all) ? all : (all.jobs ?? []);
  const imported = list.find((j) => j.importedFromLive && !j.deletedAt);
  if (!imported) throw skip('no imported job on this DB: run with DATABASE_URL (seeds one) or after test/local-setup.mjs');
  assert.ok(list.find((j) => j._id === A)?.importedFromLive === false, 'a job created here is not marked');
  const I = imported._id;
  const before = (await cm.req('GET', `/api/jobs/${I}`)).json.data;
  for (const [who, j] of [['content manager', cm], ['admin', admin]]) {
    for (const [m, p, body] of [
      ['PATCH', `/api/jobs/${I}`, { title: 'changed', status: 'Active' }],
      ['PATCH', `/api/admin/jobs/${I}/board`, { status: 'Suspended' }],
      ['PATCH', `/api/admin/jobs/${I}/board`, { isSponsored: !before.isSponsored }],
      ['POST', `/api/admin/jobs/${I}/pin`], ['DELETE', `/api/admin/jobs/${I}/pin`], ['POST', `/api/admin/jobs/${I}/bump`],
      ['POST', `/api/admin/jobs/${I}/archive`], ['POST', `/api/admin/jobs/${I}/restore`],
    ]) {
      const r = await j.req(m, p, body);
      assert.equal(r.status, 409, `${who} ${m} ${p}: ${r.status} ${r.text}`);
      assert.equal(r.json?.code, 'job_read_only', `${who} ${m} ${p}: ${r.text}`);
    }
  }
  // An integration (internal API) is refused too.
  const mint = await admin.req('POST', '/api/admin/api-tokens', { name: `e2e imported ${stamp}`, scopes: ['jobs:read', 'jobs:write'], expiresInDays: 1 });
  assert.ok(mint.json?.data?.token, mint.text);
  const ir = await fetch(BASE + `/api/internal/v1/jobs/${I}`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${mint.json.data.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'changed by integration', status: 'Active' }) });
  assert.equal(ir.status, 409, `internal API PATCH: ${ir.status}`);
  await admin.req('POST', `/api/admin/api-tokens/${mint.json.data.id}/revoke`);
  // Nothing changed, and the job is still on the public board.
  const after = (await cm.req('GET', `/api/jobs/${I}`)).json.data;
  for (const k of ['title', 'status', 'isSponsored', 'pinnedAt', 'bumpedAt', 'deletedAt', 'updatedAt']) {
    assert.deepEqual(after[k] ?? null, before[k] ?? null, `${k} changed`);
  }
  assert.ok(before.status !== 'Active' || (await boardIds()).includes(I), 'an active imported job stays on the board');
  // The importedFromLive mark is for staff only.
  assert.ok(!('importedFromLive' in ((await anon.req('GET', `/api/jobs/${I}`)).json.data ?? {})), 'no importedFromLive for the public');
  // A job created on this platform is still fully editable.
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${B}/board`, { isSponsored: true })).status, 200, 'new job editable');
  assert.equal((await cm.req('PATCH', `/api/admin/jobs/${B}/board`, { isSponsored: false })).status, 200, 'new job editable');
});

await check('activity log: every change recorded with field names only', async () => {
  const mine = [];
  for (const id of [A, B, P, S]) {
    const r = await admin.req('GET', `/api/admin/audit?subject=${id}&action=job.`);
    assert.equal(r.status, 200, r.text);
    mine.push(...r.json.data.entries);
  }
  const actions = new Set(mine.map((x) => x.action));
  for (const a of ['job.created', 'job.pinned', 'job.unpinned', 'job.bumped', 'job.board_updated', 'job.archived', 'job.restored']) {
    assert.ok(actions.has(a), `${a} missing (have ${[...actions].join(', ')})`);
  }
  for (const x of mine.filter((m) => m.action === 'job.board_updated')) {
    assert.deepEqual(Object.keys(x.details), ['fields'], `only field names: ${JSON.stringify(x.details)}`);
    assert.ok(x.details.fields.every((f) => /^[a-zA-Z]+$/.test(f)), `field names only: ${JSON.stringify(x.details)}`);
  }
  // The admin's own pin/unpin of A (check above) is theirs; everything else here was the content manager.
  const others = mine.filter((m) => !['job.updated', 'job.applied'].includes(m.action) && m.actor !== CM_EMAIL
    && !(m.actor === ADMIN_EMAIL.toLowerCase() && ['job.pinned', 'job.unpinned'].includes(m.action) && m.target === A));
  assert.deepEqual(others.map((m) => `${m.action} by ${m.actor}`), [], 'actor = the content manager');
  assert.ok(mine.some((m) => m.action === 'job.updated' && m.details.via === 'internal_api' && m.details.ignored?.includes('isSponsored')), 'integration ignore logged');
});

// cleanup: archive the test jobs (soft) so they leave the public lists
for (const id of created) await cm.req('POST', `/api/admin/jobs/${id}/archive`);

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${summary(results)}`);
process.exitCode = failed ? 1 : 0;
