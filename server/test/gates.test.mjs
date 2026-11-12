// Every API route has a gate, unless it is listed here as public (with a reason).
// A new route without a gate fails this test. Run: npx tsc && npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // not connected by this test
await import('reflect-metadata');
const { default: router } = await import('../dist/routes.js');
const { default: publicApiRouter, PUBLIC_API_PREFIX } = await import('../dist/public/publicApi.js');
const { default: publicMcpRouter } = await import('../dist/public/mcpServer.js');
const { default: internalRouter } = await import('../dist/internalApi/routes.js');
const { ALL_SCOPES } = await import('../dist/internalApi/pure.js');

const PUBLIC = new Map([
  ['GET /health-check', 'uptime probe, no data'],
  ['GET /internal/export', 'sandbox export: its own secret token, 404 without it, strict log'],
  ['POST /login', 'sign-in'],
  ['POST /logout', 'sign-out (identifies optionally)'],
  ['GET /auth/providers', 'which sign-in buttons to show (on/off flags only)'],
  ['GET /auth/session', 'only the caller: own user, or null (identifies optionally)'],
  ['GET /auth/xhostd/start', '"Continue with Google" (xhostd SSO): sets a signed state cookie and redirects to /xhost-auth/login; rate-limited'],
  ['GET /auth/xhostd/signup', 'prefill of the pending SSO sign-up: only what the signed httpOnly cookie of this visitor holds (their email and name), or null'],
  ['POST /auth/xhostd/signup', 'finishes a pending SSO sign-up: needs the signed 20-minute cookie the callback set (email from it, never the form); candidate only; rate-limited'],
  ['GET /auth/xhostd/callback', 'back from xhostd SSO: state cookie + RS256 identity cookie (iss, aud = host, exp); staff only matched to existing staff; an unknown identity gets the sign-up form, nothing is created; rate-limited'],
  ['POST /users', 'candidate sign-up; role is never taken from the request'],
  ['POST /files/:token', 'anonymous CV upload for the sign-up / guest forms; typed, size-capped, rate-limited, purged after 24 h'],
  ['DELETE /files/', "content managers a candidate's own CV; others only their own pending upload (checked in the controller)"],
  ['GET /skills', 'public list'],
  ['GET /jobs/active', 'public job ads'],
  ['GET /jobs/near', 'map search: the same public job ads, filtered by distance from a point'],
  ['GET /jobs/:jobId', 'public job ad; internal comments only for content managers (checked in the controller)'],
  ['POST /jobs/guestApply', 'guest application'],
  ['POST /job-submissions', 'employer job form: stored as pending (never public until staff approve); rate-limited per IP, honeypot, field caps, server-side validation, plain text only'],
  ['GET /locations', 'public list'],
  ['GET /locations-and-districts', 'public list'],
  ['POST /password/reset/initiate', 'same answer for any email'],
  ['POST /password/reset', 'needs the emailed one-time token'],
  // Public read-only API + MCP server (src/public): allowlisted public job data only (toPublicJob),
  // Active jobs only, no cookies/auth read, rate-limited per IP. See docs/security.md.
  ['GET /api/public/v1/', 'public API docs page (static)'],
  ['GET /api/public/v1/openapi.json', 'public API description (static)'],
  ['GET /api/public/v1/jobs', 'public job ads (allowlisted fields, Active only, page size <= 100)'],
  ['GET /api/public/v1/jobs/near', 'public job ads near a point (same as the map search)'],
  ['GET /api/public/v1/jobs/:id', 'one public job ad (Active only, allowlisted fields)'],
  ['GET /api/public/v1/locations', 'public list (towns + coordinates)'],
  ['GET /api/public/v1/skills', 'public list'],
  ['POST /mcp', 'public MCP server: JSON-RPC transport for 5 read-only tools over the same public data'],
]);

const GATES = new Set(['admin', 'contentManager', 'staff', 'signedIn']);

const routesOf = (r, prefix = '') => r.stack.filter((l) => l.route).flatMap((l) =>
  Object.keys(l.route.methods).map((m) => ({
    key: `${m.toUpperCase()} ${prefix}${l.route.path}`,
    gates: l.route.stack.map((s) => s.handle.gate).filter(Boolean),
  })));
const routes = [...routesOf(router), ...routesOf(publicApiRouter, PUBLIC_API_PREFIX), ...routesOf(publicMcpRouter)];

test('every route has a gate or is listed as public', () => {
  assert.ok(routes.length > 20, `only ${routes.length} routes found`);
  const missing = routes.filter((r) => !r.gates.some((g) => GATES.has(g)) && !PUBLIC.has(r.key));
  assert.deepEqual(missing.map((r) => r.key), []);
});

test('the public list has no stale entries', () => {
  const keys = new Set(routes.map((r) => r.key));
  assert.deepEqual([...PUBLIC.keys()].filter((k) => !keys.has(k)), []);
});

// Separation of duties: candidates' data and jobs management → content managers ONLY (not admins);
// security, the activity log and staff users → admins ONLY (not content managers).
const CONTENT_MANAGER_ONLY = ['GET /users', 'PATCH /users/:id', 'GET /files/:userId', 'GET /admin/jobs/with-comments',
  'PATCH /jobs/:jobId', 'POST /jobs', 'GET /admin/settings/apply-policy', 'PUT /admin/settings/apply-policy',
  'GET /admin/job-submissions', 'GET /admin/job-submissions/:id', 'PATCH /admin/job-submissions/:id',
  'POST /admin/job-submissions/:id/approve', 'POST /admin/job-submissions/:id/reject',
  'POST /admin/jobs/:jobId/pin', 'DELETE /admin/jobs/:jobId/pin', 'PATCH /admin/jobs/:jobId/board',
  'POST /admin/jobs/:jobId/archive', 'POST /admin/jobs/:jobId/restore', 'GET /admin/jobs/:jobId/applications-count'];
const ADMIN_ONLY = ['GET /admin/security', 'POST /admin/security/grant', 'POST /admin/security/alerts/:id/handle',
  'POST /admin/security/reviews/:userId', 'POST /admin/security/admins/:userId/revoke', 'GET /admin/audit',
  'GET /admin/staff', 'POST /admin/staff', 'PATCH /admin/staff/:userId/role', 'POST /admin/staff/:userId/deactivate',
  'POST /admin/staff/:userId/activate', 'POST /admin/staff/:userId/revoke-sessions'];

const gatesOf = (k) => {
  const r = routes.find((x) => x.key === k);
  assert.ok(r, `${k} not found`);
  return r.gates;
};

test('candidate data and jobs management are content-manager-only', () => {
  for (const k of CONTENT_MANAGER_ONLY) assert.deepEqual(gatesOf(k), ['contentManager'], `${k} is not content-manager-only`);
});

test('security, the activity log and staff users are admin-only', () => {
  for (const k of ADMIN_ONLY) assert.deepEqual(gatesOf(k), ['admin'], `${k} is not admin-only`);
});

test('every /admin/security, /admin/audit and /admin/staff route is admin-only; nothing else is', () => {
  for (const r of routes) {
    const securityArea = /^\w+ \/admin\/(security|audit|staff)\b/.test(r.key);
    assert.equal(r.gates.includes('admin'), securityArea, `${r.key}: admin gate ${securityArea ? 'missing' : 'outside the security area'}`);
  }
});

test('the gates admit exactly their roles', async () => {
  const { adminOnly, contentManagerOnly, signedIn, staffOnly } = await import('../dist/middleware/jwtAuthMiddleware.js');
  assert.equal(staffOnly.gate, 'staff');
  assert.deepEqual([...staffOnly.roles].sort(), ['admin', 'content_manager']);
  assert.equal(adminOnly.gate, 'admin');
  assert.deepEqual(adminOnly.roles, ['admin']);
  assert.equal(contentManagerOnly.gate, 'contentManager');
  assert.deepEqual(contentManagerOnly.roles, ['content_manager']);
  assert.equal(signedIn.gate, 'signedIn');
  assert.deepEqual([...signedIn.roles].sort(), ['admin', 'content_manager', 'user']);
});

test('employer submission review routes are gated (contentGate) and the public submit is rate-limited', () => {
  const review = ['GET /admin/job-submissions', 'GET /admin/job-submissions/:id', 'PATCH /admin/job-submissions/:id',
    'POST /admin/job-submissions/:id/approve', 'POST /admin/job-submissions/:id/reject'];
  for (const k of review) {
    const r = routes.find((x) => x.key === k);
    assert.ok(r, `${k} not found`);
    assert.ok(r.gates.some((g) => g !== 'optional') && !PUBLIC.has(k), `${k} has no gate`);
  }
  const submit = router.stack.find((l) => l.route?.path === '/job-submissions' && l.route.methods.post);
  assert.ok(submit.route.stack.length >= 2, 'POST /job-submissions has no rate limiter in front of the handler');
});

test('the public API is GET-only and ungated; the MCP server is POST /mcp only', () => {
  const pub = routes.filter((r) => r.key.includes(' /api/public/') || r.key.endsWith(' /mcp'));
  assert.ok(pub.length >= 8);
  for (const r of pub) {
    assert.ok(r.key.startsWith('GET /api/public/v1') || r.key === 'POST /mcp', `${r.key} is not a read`);
    assert.deepEqual(r.gates, [], `${r.key}: the public surface must not use the site's auth gates`);
  }
  // The site router has nothing under the public prefix (that would bypass the public rules).
  assert.deepEqual(routesOf(router).filter((r) => r.key.includes('/public/') || r.key.includes('/mcp')).map((r) => r.key), []);
});

// ---- internal API (/api/internal/v1): its own gate, never the user JWT, scopes on every route ----
const internalRoutes = internalRouter.stack.filter((l) => l.route).flatMap((l) =>
  Object.keys(l.route.methods).map((m) => ({
    key: `${m.toUpperCase()} /internal/v1${l.route.path}`,
    handles: l.route.stack.map((s) => s.handle),
  })));

test('the internal API is mounted on the main router at /internal/v1', () => {
  assert.ok(router.stack.some((l) => !l.route && l.handle === internalRouter && l.regexp.test('/internal/v1/jobs')));
  assert.ok(internalRoutes.length >= 15, `only ${internalRoutes.length} internal routes found`);
});

test('every internal API route has internalApiAuth with known scopes, and no user-JWT gate', () => {
  for (const r of internalRoutes) {
    const gates = r.handles.filter((h) => h.gate);
    assert.deepEqual(gates.map((g) => g.gate), ['internalApi'], `${r.key}: expected exactly one internalApi gate`);
    assert.equal(r.handles[0].gate, 'internalApi', `${r.key}: the gate must run first`);
    const scopes = gates[0].scopes;
    assert.ok(Array.isArray(scopes) && scopes.length > 0 && scopes.every((s) => ALL_SCOPES.includes(s)), `${r.key}: bad scopes ${scopes}`);
  }
});

test('people and CV routes of the internal API need their scopes; Salesforce pushes need salesforce:push', () => {
  const need = {
    'GET /internal/v1/candidates': ['candidates:read'],
    'GET /internal/v1/candidates/:id/cv': ['candidates:read', 'cvs:read'],
    'GET /internal/v1/applications': ['applications:read'],
    'GET /internal/v1/applications/:id/cv': ['applications:read', 'cvs:read'],
    'POST /internal/v1/jobs': ['jobs:write'],
    'PATCH /internal/v1/jobs/:id': ['jobs:write'],
    'POST /internal/v1/salesforce/push-pending': ['salesforce:push'],
  };
  for (const [k, scopes] of Object.entries(need)) {
    const r = internalRoutes.find((x) => x.key === k);
    assert.ok(r, `${k} not found`);
    for (const s of scopes) assert.ok(r.handles[0].scopes.includes(s), `${k} lacks ${s}`);
  }
});

test('token management is open to both staff roles only (the create handler limits people scopes)', () => {
  for (const k of ['GET /admin/api-tokens', 'POST /admin/api-tokens', 'POST /admin/api-tokens/:id/revoke']) {
    const r = routes.find((x) => x.key === k);
    assert.ok(r, `${k} not found`);
    assert.deepEqual(r.gates, ['staff'], `${k} is not staffOnly`);
  }
  // staff is used only for token oversight: candidates' data never gets a gate an admin passes.
  const staffRoutes = routes.filter((r) => r.gates.includes('staff')).map((r) => r.key);
  assert.ok(staffRoutes.every((k) => /^\w+ \/admin\/api-tokens\b/.test(k)), `staff gate outside token management: ${staffRoutes}`);
});

test('people scopes can be issued only by a content manager; admins get jobs and salesforce:push', async () => {
  const { issuableScopes, PEOPLE_SCOPES, ALL_SCOPES: all } = await import('../dist/internalApi/pure.js');
  assert.deepEqual([...PEOPLE_SCOPES].sort(), ['applications:read', 'candidates:read', 'cvs:read']);
  assert.deepEqual(issuableScopes('content_manager'), all);
  assert.deepEqual(issuableScopes('admin'), ['jobs:read', 'jobs:write', 'salesforce:push']);
  assert.deepEqual(issuableScopes('user'), []);
  assert.deepEqual(issuableScopes(undefined), []);
});
