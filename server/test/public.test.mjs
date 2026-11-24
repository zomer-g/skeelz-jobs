// The public API (/api/public/v1) and public MCP server (/mcp) boundary, without a DB.
// Run: npx tsc && npm test. The live data checks are in test/e2e.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // never reached here
await import('reflect-metadata');
const express = (await import('express')).default;
const pub = await import('../dist/public/publicJob.js');
const params = await import('../dist/public/publicParams.js');
const service = await import('../dist/public/publicService.js');
const { default: apiRouter, PUBLIC_API_PREFIX } = await import('../dist/public/publicApi.js');
const { default: mcpRouter, createPublicMcpServer, PUBLIC_MCP_TOOLS, MCP_PATH } = await import('../dist/public/mcpServer.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const sorted = (a) => [...a].sort();

// A job with every field the DAL can return, plus fields that must never leak.
const fullJob = (over = {}) => ({
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Dev', jobScope: ['FullTime'], companyName: 'Acme',
  publishDate: new Date('2026-11-01T08:00:00Z'), citySymbol: 5000, description: '<p>x</p>', jobId: 123,
  contactPersonName: 'Dana', contactPersonPhone: '050-0000000', contactPersonEmail: 'dana@example.test',
  externalLink: 'https://example.test/apply', uploadBy: 'admin@example.test', status: 'Active', comments: 'internal note',
  location: { _id: '5000', city: 'תל אביב - יפו', district: 'תל אביב', lat: 32.08, lng: 34.78, identifier: 1 },
  requiredSkills: ['bbbbbbbbbbbbbbbbbbbbbbbb'], requiredSkillsDetails: { bbbbbbbbbbbbbbbbbbbbbbbb: 'Excel' },
  isSponsored: true, isMarked: true, isSelfApply: false, guestModeOverride: 'none', quickCvOverride: 'required', regularCvOverride: 'required',
  applyPolicy: { guestMode: 'quick', quickCv: 'required', regularCv: 'required' }, dateToDisplay: 'today',
  createdAt: new Date(), updatedAt: new Date(), salesforceId: '500XX', newColumnFromTheFuture: 'secret',
  // Added job fields (settings screen): the staff map never goes out; only the job-page list does, label + value only.
  customFields: { aaaaaaaaaaaaaaaaaaaaaaab: 'staff-only answer' }, extraFields: [{ label: 'שכר', value: '40 ₪', id: 'leak-id', active: true }],
  ...over,
});

test('toPublicJob returns exactly the allowlisted keys (fails if a field appears)', () => {
  const j = pub.toPublicJob(fullJob());
  assert.deepEqual(sorted(Object.keys(j)), sorted([
    'id', 'jobNumber', 'title', 'companyName', 'description', 'jobScope', 'publishDate', 'location', 'skills', 'isSponsored', 'isPinned', 'externalLink', 'applyMode', 'applyContact', 'thresholdCondition', 'extraFields', 'url',
  ]));
  assert.deepEqual(sorted(Object.keys(j)), sorted(pub.PUBLIC_JOB_KEYS));
  assert.deepEqual(sorted(Object.keys(j.location)), sorted(pub.PUBLIC_LOCATION_KEYS));
  assert.deepEqual(sorted(Object.keys(j.skills[0])), sorted(pub.PUBLIC_SKILL_KEYS));
  const text = JSON.stringify(j);
  assert.deepEqual(j.extraFields, [{ label: 'שכר', value: '40 ₪' }]);
  for (const secret of ['Dana', '050-0000000', 'dana@example.test', 'internal note', 'admin@example.test', '500XX', 'secret', 'Override', 'required', 'quickCv', 'regularCv', 'staff-only answer', 'leak-id']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.equal(j.applyMode, 'quick');
  assert.equal(j.applyContact, null); // not a self-apply job: no employer contact
  assert.equal(j.url, 'https://jobs.skeelz.co.il/job/aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(j.skills, [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Excel' }]);
});

test('minimal job: same key set, nulls instead of missing fields', () => {
  const j = pub.toPublicJob({ _id: 'cccccccccccccccccccccccc', status: 'Active', jobId: 1, title: 't', companyName: 'c', description: '',
    publishDate: new Date('2026-01-01T00:00:00Z') }); // a job without a (reached) publish date is never public
  assert.deepEqual(sorted(Object.keys(j)), sorted(pub.PUBLIC_JOB_KEYS));
  assert.equal(j.location, null);
  assert.equal(j.externalLink, null);
  assert.deepEqual(j.extraFields, []);
  assert.equal(pub.toPublicJob(fullJob({ externalLink: 'javascript:alert(1)' })).externalLink, null);
});

test('self-apply job: applyContact carries only name, email, phone (as stored for applicants)', () => {
  const j = pub.toPublicJob(fullJob({ isSelfApply: true, applyPolicy: { guestMode: 'self', quickCv: 'optional', regularCv: 'required' } }));
  assert.equal(j.applyMode, 'self');
  assert.deepEqual(sorted(Object.keys(j.applyContact)), sorted(pub.PUBLIC_APPLY_CONTACT_KEYS));
  assert.deepEqual(j.applyContact, { name: 'Dana', email: 'dana@example.test', phone: '050-0000000' });
  for (const secret of ['internal note', 'admin@example.test', 'regularCv', 'Override']) assert.ok(!JSON.stringify(j).includes(secret), secret);
  // No contact stored: null rather than an empty object; a bad email is dropped.
  const none = pub.toPublicJob(fullJob({ contactPersonName: '', contactPersonPhone: null, contactPersonEmail: 'not-an-email',
    applyPolicy: { guestMode: 'self', quickCv: 'optional', regularCv: 'optional' } }));
  assert.equal(none.applyContact, null);
  // guest mode none: no contact, mode none
  const closed = pub.toPublicJob(fullJob({ applyPolicy: { guestMode: 'none', quickCv: 'optional', regularCv: 'optional' } }));
  assert.equal(closed.applyMode, 'none');
  assert.equal(closed.applyContact, null);
});

test('near job adds only distanceKm', () => {
  const j = pub.toPublicNearJob({ ...fullJob(), distanceKm: 3.2 });
  assert.deepEqual(sorted(Object.keys(j)), sorted(pub.PUBLIC_NEAR_JOB_KEYS));
  assert.equal(j.distanceKm, 3.2);
});

test('only Active jobs are public: pending / private / suspended / closed / rejected never appear', () => {
  for (const status of ['Suspended', 'Closed', 'pending', 'Pending', 'private', 'Private', 'rejected', 'approved', 'active', '', undefined, null]) {
    assert.equal(pub.toPublicJob(fullJob({ status })), null, `status ${status} leaked`);
    assert.equal(pub.toPublicNearJob({ ...fullJob({ status }), distanceKm: 1 }), null);
  }
  const list = pub.publicJobs([fullJob(), fullJob({ status: 'pending', _id: 'dddddddddddddddddddddddd' }), fullJob({ status: 'Suspended' })]);
  assert.equal(list.length, 1);
  // The query filter is an explicit status check (stays right when new statuses are added).
  assert.equal(service.PUBLIC_JOB_WHERE, "j.status = 'Active'");
});

test('archived and not-yet-published (scheduled) jobs are never public; the retired isPublic flag changes nothing', () => {
  assert.ok(pub.toPublicJob(fullJob({ isPublic: false })), 'the status alone decides (no private jobs)');
  assert.equal(pub.toPublicJob(fullJob({ deletedAt: new Date() })), null, 'archived leaked');
  assert.equal(pub.toPublicJob(fullJob({ publishDate: new Date(Date.now() + 86_400_000) })), null, 'scheduled leaked');
  assert.ok(pub.toPublicJob(fullJob({ isPublic: true, pinnedAt: new Date() })), 'a pinned public job is public');
  // The pin, visibility and archive fields are not part of the public shape.
  const j = pub.toPublicJob(fullJob({ pinnedAt: new Date(), isPublic: true, deletedAt: null, managedFields: ['isSponsored'] }));
  for (const k of ['pinnedAt', 'isPublic', 'deletedAt', 'managedFields', 'deletedBy']) assert.ok(!(k in j), `${k} leaked`);
  // The list queries carry the same rule.
  assert.deepEqual(service.PUBLIC_WHERE.slice(0, 1), ["j.status = 'Active'"]);
  assert.match(service.PUBLIC_WHERE[1], /j\.status = 'Active' AND j\.deleted_at IS NULL AND j\.publish_date <= now\(\)/);
  assert.ok(!/is_public/.test(service.PUBLIC_WHERE.join(' ')), 'is_public is no longer read');
});

test('location and skill shapes are allowlists', () => {
  const l = pub.toPublicLocation({ _id: '5000', citySymbol: 5000, city: 'x', district: 'y', identifier: 3, lat: 1, lng: 2, secret: 1 });
  assert.deepEqual(sorted(Object.keys(l)), sorted(pub.PUBLIC_LOCATION_KEYS));
  const s = pub.toPublicSkill({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Excel', createdBy: 'x' });
  assert.deepEqual(sorted(Object.keys(s)), sorted(pub.PUBLIC_SKILL_KEYS));
});

test('input is bounded: page size cap, text length, filter count, coordinates', () => {
  const d = params.parseJobSearch({});
  assert.equal(d.limit, params.PUBLIC_LIMITS.defaultPageSize);
  assert.equal(params.parseJobSearch({ limit: '100' }).limit, 100);
  assert.throws(() => params.parseJobSearch({ limit: '101' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ limit: '0' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ page: '100000', limit: '100' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ q: 'x'.repeat(101) }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ q: { $ne: 1 } }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ skills: Array.from({ length: 21 }, (_, i) => `s${i}`).join(',') }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ scope: 'Everything' }), params.PublicInputError);
  assert.deepEqual(params.parseJobSearch({ skills: 'a,b', location: ['1', '2'] }).skills, ['a', 'b']);
  assert.deepEqual(params.parseJobSearch({ lat: '32', lng: '34.8', radiusKm: '10' }).near, { lat: 32, lng: 34.8, radiusKm: 10 });
  assert.throws(() => params.parseJobSearch({ lat: '32' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ lat: '48.8', lng: '2.3', radiusKm: '5' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({ lat: '32', lng: '34.8', radiusKm: '201' }), params.PublicInputError);
  assert.throws(() => params.parseJobSearch({}, { nearRequired: true }), params.PublicInputError);
  assert.deepEqual(params.parseJobRef('123'), { number: 123 });
  assert.deepEqual(params.parseJobRef('aaaaaaaaaaaaaaaaaaaaaaaa'), { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.throws(() => params.parseJobRef("1' OR 1=1"), params.PublicInputError);
});

const routesOf = (router) => router.stack.filter((l) => l.route).flatMap((l) =>
  Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));

test('every public REST route is GET; the MCP router has only POST /mcp', () => {
  const api = routesOf(apiRouter);
  assert.deepEqual(sorted(api), sorted(['GET /', 'GET /openapi.json', 'GET /jobs', 'GET /jobs/near', 'GET /jobs/:id', 'GET /locations', 'GET /skills']));
  assert.deepEqual(routesOf(mcpRouter), ['POST /mcp']);
  assert.equal(PUBLIC_API_PREFIX, '/api/public/v1');
  assert.equal(MCP_PATH, '/mcp');
});

test('MCP tool list is exactly the read-only set; no resources, no prompts', async () => {
  const server = createPublicMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  const { tools } = await client.listTools();
  assert.deepEqual(sorted(tools.map((t) => t.name)), sorted(PUBLIC_MCP_TOOLS));
  assert.deepEqual(sorted(PUBLIC_MCP_TOOLS), sorted(['search_jobs', 'get_job', 'jobs_near', 'list_locations', 'list_skills']));
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} not readOnly`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructive`);
  }
  const caps = client.getServerCapabilities();
  assert.ok(caps.tools);
  assert.equal(caps.resources, undefined);
  assert.equal(caps.prompts, undefined);
  await assert.rejects(client.listResources());
  await assert.rejects(client.listPrompts());
  // Bad input comes back as a tool error, before any DB access.
  const r = await client.callTool({ name: 'get_job', arguments: { id: 'nope' } });
  assert.equal(r.isError, true);
  await client.close();
});

// HTTP behaviour, mounted the way index.ts mounts it (no DB needed for these paths).
const app = express();
app.set('query parser', 'extended');
app.use(PUBLIC_API_PREFIX, apiRouter);
app.use(mcpRouter);
app.use('/api', (req, res, next) => {
  // stands in for the site's cross-site refusal: the public routers must answer before it
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ code: 'cross_site' });
  next();
});
app.use((_req, res) => res.status(418).end());
const srv = http.createServer(app).listen(0);
after(() => srv.close());
const base = `http://127.0.0.1:${srv.address().port}`;

const PATHS = ['/', '/openapi.json', '/jobs', '/jobs/near', '/jobs/aaaaaaaaaaaaaaaaaaaaaaaa', '/locations', '/skills', '/anything'];

test('every method other than GET/HEAD/OPTIONS gets 405 on every public path', async () => {
  for (const p of PATHS) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await fetch(base + PUBLIC_API_PREFIX + p, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 405, `${method} ${p}`);
      assert.equal(r.headers.get('allow'), 'GET, HEAD, OPTIONS');
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
    }
  }
});

test('CORS is open for reads only, without credentials; cross-site GET is not refused', async () => {
  const pre = await fetch(base + PUBLIC_API_PREFIX + '/jobs', { method: 'OPTIONS', headers: { Origin: 'https://other.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  const r = await fetch(base + PUBLIC_API_PREFIX + '/openapi.json', { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://other.example' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('openapi.json: cache headers, ETag and 304', async () => {
  const r = await fetch(base + PUBLIC_API_PREFIX + '/openapi.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /^public, max-age=\d+$/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const spec = await r.json();
  assert.equal(spec.openapi, '3.1.0');
  for (const [path, ops] of Object.entries(spec.paths)) assert.deepEqual(Object.keys(ops), ['get'], `${path} has non-GET ops`);
  assert.deepEqual(sorted(spec.components.schemas.Job.required), sorted(pub.PUBLIC_JOB_KEYS));
  assert.deepEqual(sorted(Object.keys(spec.components.schemas.Job.properties)), sorted(pub.PUBLIC_JOB_KEYS));
  // (fetch adds Cache-Control: no-cache to conditional requests unless one is given)
  const again = await fetch(base + PUBLIC_API_PREFIX + '/openapi.json', { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
  assert.equal(again.status, 304);
});

test('bad input is 400 JSON, unknown path 404 JSON, both inside the prefix', async () => {
  const bad = await fetch(base + PUBLIC_API_PREFIX + '/jobs?limit=500');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'pub400');
  assert.equal(bad.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + PUBLIC_API_PREFIX + '/jobs/near?lat=1')).status, 400);
  assert.equal((await fetch(base + PUBLIC_API_PREFIX + '/jobs/x')).status, 400);
  const nf = await fetch(base + PUBLIC_API_PREFIX + '/users');
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).code, 'pub404');
});

test('docs page is HTML with its own CSP', async () => {
  const r = await fetch(base + PUBLIC_API_PREFIX + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

const rpc = (body, headers = {}) => fetch(base + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('MCP over HTTP: CORS preflight, initialize, tools/list; GET/DELETE are 405; bad JSON is a parse error', async () => {
  const pre = await fetch(base + '/mcp', { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-protocol-version' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { Origin: 'http://localhost:6274' });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get('access-control-allow-origin'), '*');
  const ij = await init.json();
  assert.equal(ij.result.serverInfo.name, 'skeelz-jobs');
  assert.equal(ij.result.capabilities.resources, undefined);
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'Mcp-Protocol-Version': '2025-06-18' })).json();
  assert.deepEqual(sorted(list.result.tools.map((t) => t.name)), sorted(PUBLIC_MCP_TOOLS));
  for (const m of ['GET', 'DELETE', 'PUT']) assert.equal((await fetch(base + '/mcp', { method: m })).status, 405, m);
  const bad = await rpc('{not json');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

test('the /developers page quotes the same limits and MCP tools as the code', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', '..', 'client', 'src', 'components', 'developers', 'DevelopersPage.tsx'), 'utf8');
  const nums = src.match(/DEVELOPER_NUMBERS = (\{[^}]+\})/);
  const tools = src.match(/DEVELOPER_MCP_TOOLS = (\[[^\]]+\])/);
  assert.ok(nums && tools, 'DEVELOPER_NUMBERS / DEVELOPER_MCP_TOOLS not found');
  const L = params.PUBLIC_LIMITS;
  assert.deepEqual(Function(`return ${nums[1]}`)(), {
    restPerMinute: L.restPerMinute, mcpPerMinute: L.mcpPerMinute, maxPageSize: L.maxPageSize,
    defaultPageSize: L.defaultPageSize, maxRadiusKm: L.maxRadiusKm,
  });
  assert.deepEqual(Function(`return ${tools[1]}`)(), [...PUBLIC_MCP_TOOLS]);
});
