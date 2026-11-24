// Every API route has a gate, unless it is listed here as public (with a reason).
// A new route without a gate fails this test. Run: npx tsc && npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // not connected by this test
await import('reflect-metadata');
const { default: router, devRouter } = await import('../dist/routes.js');
const { default: publicApiRouter, PUBLIC_API_PREFIX } = await import('../dist/public/publicApi.js');
const { default: publicMcpRouter } = await import('../dist/public/mcpServer.js');
const { default: internalRouter } = await import('../dist/internalApi/routes.js');
const { default: seoRouter } = await import('../dist/seo/seoRoutes.js');
const { ALL_SCOPES } = await import('../dist/internalApi/pure.js');

const PUBLIC = new Map([
  ['GET /health-check', 'uptime probe, no data'],
  ['GET /internal/export', 'sandbox export: its own secret token, 404 without it, strict log'],
  ['POST /logout', 'sign-out (identifies optionally)'],
  ['GET /auth/providers', 'which sign-in buttons to show (on/off flags only)'],
  ['GET /auth/session', 'only the caller: own user, or null (identifies optionally)'],
  ['GET /auth/xhostd/start', '"Continue with Google" (xhostd SSO): sets a signed state cookie and redirects to /xhost-auth/login; rate-limited'],
  ['GET /auth/xhostd/signup', 'prefill of the pending SSO sign-up: only what the signed httpOnly cookie of this visitor holds (their email and name), or null'],
  ['POST /auth/xhostd/signup', 'finishes a pending SSO sign-up: needs the signed 20-minute cookie the callback set (email from it, never the form); candidate only; rate-limited'],
  ['GET /auth/microsoft/start', '"Continue with Microsoft" (candidates only; off unless ENABLE_MICROSOFT_SSO): sets a signed state/nonce/PKCE cookie and redirects to login.microsoftonline.com; rate-limited'],
  ['GET /auth/microsoft/callback', 'back from Microsoft: state cookie, code + PKCE exchanged server to server, ID token checked (RS256 JWKS, issuer of its tenant, aud = client id, exp, nonce); verified email only; never staff; an unknown identity gets the sign-up form; rate-limited'],
  ['GET /auth/xhostd/callback', 'back from xhostd SSO: state cookie + RS256 identity cookie (iss, aud = host, exp); staff only matched to existing staff; an unknown identity gets the sign-up form, nothing is created; rate-limited'],
  ['POST /auth/email/request', 'sign-in code by email: the same answer for any address (no account enumeration); per-IP and per-address limits; staff get no code'],
  ['POST /auth/email/verify', 'checks a sign-in code: hashed, 10 minutes, single use, 5 tries; signs in a candidate or opens the sign-up form; per-IP limit'],
  ['GET /auth/email/signup', 'prefill of the pending email sign-up: only the address in the signed httpOnly cookie, or null'],
  ['POST /auth/email/signup', 'finishes a pending email sign-up: needs the signed 20-minute cookie set after a right code (email from it, never the form); candidate only; consent checked; rate-limited'],
  // Development only: mounted by index.ts only with DEV_MODE=true outside production (the handlers check again).
  ['GET /dev/email-code', 'DEV_MODE only, never mounted in production: the last sign-in code of an address, for the e2e scripts'],
  ['POST /dev/email-code', 'DEV_MODE only, never mounted in production: a sign-in code without the per-address limits, for the e2e scripts'],
  ['POST /files/:token', 'CV upload for the sign-up / guest forms (identifies a signed-in uploader optionally, for the log); typed, size-capped, rate-limited, purged after 24 h'],
  ['DELETE /files/', "content managers unlink a candidate's own CV from the profile (file kept); others only their own pending upload (checked in the controller)"],
  ['GET /auth/signup-fields', 'the sign-up form: which fields are required / optional / hidden (the setting only, no personal data)'],
  ['GET /custom-fields/signup', "the sign-up form's added questions: active definitions only (label, type, options, required), never an answer"],
  ['GET /custom-fields/job', "the employer form's added job fields: active definitions only (label, type, options, required), never an answer or a staff flag"],
  ['GET /skills', 'public list'],
  ['GET /jobs/active', 'public job ads'],
  ['GET /jobs/near', 'map search: the same public job ads, filtered by distance from a point'],
  ['GET /jobs/:jobId', 'public job ad; internal comments only for content managers (checked in the controller)'],
  ['POST /jobs/guestApply', 'guest application'],
  ['POST /job-submissions', 'employer job form: stored as pending (never public until staff approve); rate-limited per IP, honeypot, field caps, server-side validation, plain text only; with the setting account_required only a signed-in employer (DB role, checked in the controller)'],
  ['GET /job-submissions/policy', "whether the employer form needs an employer account: the setting's mode only (open / account_required)"],
  ['GET /locations', 'public list'],
  ['GET /locations-and-districts', 'public list'],
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
  // Search engines (src/seo, docs/seo.md): Disallow everything unless ALLOW_INDEXING on the PUBLIC_SITE_URL host.
  ['GET /robots.txt', 'crawler rules: Disallow all unless indexing is on for the canonical host; no data'],
  ['GET /sitemap.xml', 'addresses of the public pages and public job ads (Active only, toPublicJob); 404 unless indexable'],
  // Resend's delivery events (src/mail): no session; instead a Svix signature over the raw body with RESEND_WEBHOOK_SECRET
  // (401 without it, 503 when the secret is not set), five-minute timestamp window, each message id handled once. It only
  // updates send statuses and adds keyed hashes of bounced / complaining addresses to the suppression list; it returns nothing.
  // The one-click unsubscribe of a marketing email (RFC 8058): no session; an HMAC-signed token (keyed hash of the address
  // + account id, never the address). Only ever REMOVES from marketing; the same answer for any valid token; rate-limited.
  ['POST /unsubscribe', 'one-click unsubscribe: signed token only, removes from marketing mail (never adds), neutral answer, rate-limited'],
  ['POST /webhooks/resend', 'Resend webhook: signed (Svix HMAC, raw body, timestamp window, replay-safe); writes only send statuses and suppression hashes; rate-limited'],
]);

const GATES = new Set(['admin', 'contentManager', 'staffViewer', 'staff', 'signedIn', 'employer', 'account']);
// anyAccount (any signed-in account, whatever its roles): ONLY for adding a role to oneself (owner, 23.11.2026).
const ANY_ACCOUNT = ['POST /users/me/roles/candidate', 'POST /users/me/roles/employer'];

const routesOf = (r, prefix = '') => r.stack.filter((l) => l.route).flatMap((l) =>
  Object.keys(l.route.methods).map((m) => ({
    key: `${m.toUpperCase()} ${prefix}${l.route.path}`,
    gates: l.route.stack.map((s) => s.handle.gate).filter(Boolean),
  })));
const routes = [...routesOf(router), ...routesOf(devRouter), ...routesOf(publicApiRouter, PUBLIC_API_PREFIX), ...routesOf(publicMcpRouter), ...routesOf(seoRouter)];

test('every route has a gate or is listed as public', () => {
  assert.ok(routes.length > 20, `only ${routes.length} routes found`);
  const missing = routes.filter((r) => !r.gates.some((g) => GATES.has(g)) && !PUBLIC.has(r.key));
  assert.deepEqual(missing.map((r) => r.key), []);
});

test('the CV upload identifies a signed-in uploader, so the log names them (not anonymous:<address>)', () => {
  const r = routes.find((x) => x.key === 'POST /files/:token');
  assert.ok(r, 'POST /files/:token not found');
  assert.ok(r.gates.includes('optional'), 'POST /files/:token does not run tryExtractTokenPayloadMiddleware');
});

test('the public list has no stale entries', () => {
  const keys = new Set(routes.map((r) => r.key));
  assert.deepEqual([...PUBLIC.keys()].filter((k) => !keys.has(k)), []);
});

// Roles (owner, 19.11.2026): viewing candidates and managing jobs → the staffViewer gate (placement coordinators,
// content managers AND admins); settings, candidates' records, forwards and Salesforce pushes → the contentManager
// gate (content managers AND admins); security, the activity log and staff users → admins ONLY.
const STAFF_VIEWERS = ['GET /users', 'GET /admin/users/:id/marketing', 'GET /files/:userId', 'GET /admin/users/:userId/applications/:jobId/cv', 'GET /admin/jobs/with-comments',
  'PATCH /jobs/:jobId', 'POST /jobs', 'GET /admin/settings/apply-policy',
  'GET /admin/job-submissions', 'GET /admin/job-submissions/:id', 'PATCH /admin/job-submissions/:id',
  'POST /admin/job-submissions/:id/approve', 'POST /admin/job-submissions/:id/reject',
  'POST /admin/jobs/:jobId/pin', 'POST /admin/jobs/:jobId/bump', 'DELETE /admin/jobs/:jobId/pin', 'PATCH /admin/jobs/:jobId/board',
  'POST /admin/jobs/:jobId/archive', 'POST /admin/jobs/:jobId/restore', 'GET /admin/jobs/:jobId/applications-count',
  'GET /admin/guest-applications', 'GET /admin/guest-applications/:id/cv',
  'GET /admin/job-edit-requests', 'GET /admin/job-edit-requests/:id', 'POST /admin/job-edit-requests/:id/approve',
  'POST /admin/job-edit-requests/:id/reject', 'GET /admin/employer-forwards',
  // The job form's added fields (definitions, active only): everyone who edits jobs.
  'GET /admin/job-fields'];
const CONTENT_MANAGER_ONLY = ['PATCH /users/:id', 'PUT /admin/settings/apply-policy',
  'GET /admin/settings/employer-posting', 'PUT /admin/settings/employer-posting',
  'GET /admin/settings/signup-fields', 'PUT /admin/settings/signup-fields',
  // The settings screen's added fields (owner, 23.11.2026: every content manager, not coordinators).
  'GET /admin/settings/custom-fields', 'POST /admin/settings/custom-fields', 'PATCH /admin/settings/custom-fields/:id',
  'POST /admin/guest-applications/salesforce-push',
  'POST /admin/employer-forwards', 'POST /admin/employer-forwards/:id/cancel',
  // Service emails: events on/off and templates (owner, 23.11.2026: content managers and admins). Test sends go only to
  // the editor's own address.
  'GET /admin/mail', 'POST /admin/mail/preview', 'POST /admin/mail/test', 'POST /admin/mail/suppressions/remove',
  'GET /admin/mail/kinds/:kind', 'POST /admin/mail/kinds/:kind/versions', 'POST /admin/mail/kinds/:kind/versions/:id/publish',
  'POST /admin/mail/kinds/:kind/reset', 'PUT /admin/mail/kinds/:kind/enabled',
  // Marketing removals on the person's request (owner, 23.11.2026): content managers and admins; nobody can mark "agreed".
  'POST /admin/users/:id/marketing-optout', 'POST /admin/marketing/optouts'];
// The employer's own area: employerOnly, and nothing else admits an employer.
const EMPLOYER_ONLY = ['GET /employer/me', 'PATCH /employer/me', 'GET /employer/submissions', 'POST /employer/submissions/claim',
  'GET /employer/jobs', 'GET /employer/jobs/:jobId', 'POST /employer/jobs/:jobId/edit-requests', 'GET /employer/edit-requests',
  'POST /employer/edit-requests/:id/withdraw', 'GET /employer/applicants', 'GET /employer/applicants/:forwardId/cv'];
const ADMIN_ONLY = ['GET /admin/security', 'POST /admin/security/grant', 'POST /admin/security/alerts/:id/handle',
  'POST /admin/security/reviews/:userId', 'POST /admin/security/admins/:userId/revoke', 'GET /admin/audit', 'GET /admin/audit/person',
  'GET /admin/staff', 'POST /admin/staff', 'PATCH /admin/staff/:userId/role', 'POST /admin/staff/:userId/deactivate',
  'POST /admin/staff/:userId/activate', 'POST /admin/staff/:userId/revoke-sessions',
  'GET /admin/security/salesforce', 'POST /admin/security/salesforce/check', 'POST /admin/security/salesforce/retry',
  // The existing site's jobs (mirror state, read now) and the cutover report: admins only.
  'GET /admin/security/salesforce/legacy-jobs', 'POST /admin/security/salesforce/legacy-jobs/run', 'GET /admin/security/salesforce/cutover-report',
  'GET /admin/security/salesforce/legacy-candidates', 'POST /admin/security/salesforce/legacy-candidates/run',
  // Linking the settings screen's added fields to Salesforce fields (owner, 23.11.2026).
  'GET /admin/security/salesforce/custom-fields', 'PUT /admin/security/salesforce/custom-fields/:id',
  // Blocking a role of an account (owner, 24.11.2026): admins only.
  'GET /admin/role-blocks', 'GET /admin/role-blocks/:userId', 'PUT /admin/role-blocks/:userId/:role'];

const gatesOf = (k) => {
  const r = routes.find((x) => x.key === k);
  assert.ok(r, `${k} not found`);
  return r.gates;
};

test('viewing candidates and managing jobs: coordinators, content managers and admins (staffViewer gate)', () => {
  for (const k of STAFF_VIEWERS) assert.deepEqual(gatesOf(k), ['staffViewer'], `${k} is not staffViewers`);
});

test("settings, candidates' records, forwards and Salesforce pushes are content-manager-only", () => {
  for (const k of CONTENT_MANAGER_ONLY) assert.deepEqual(gatesOf(k), ['contentManager'], `${k} is not content-manager-only`);
});

test('every staffViewer / contentManager route is on its list (a new one must be placed on purpose)', () => {
  const on = (g) => routes.filter((r) => r.gates.includes(g)).map((r) => r.key).sort();
  assert.deepEqual(on('staffViewer'), [...STAFF_VIEWERS].sort());
  assert.deepEqual(on('contentManager'), [...CONTENT_MANAGER_ONLY].sort());
  // Every write a coordinator can reach is a job write (never a candidate's record, a setting or a forward).
  const writes = STAFF_VIEWERS.filter((k) => !k.startsWith('GET '));
  assert.ok(writes.every((k) => /^\w+ \/(jobs\b|admin\/jobs\/|admin\/job-submissions\/|admin\/job-edit-requests\/)/.test(k)), `coordinator writes: ${writes}`);
});

test('security, the activity log and staff users are admin-only', () => {
  for (const k of ADMIN_ONLY) assert.deepEqual(gatesOf(k), ['admin'], `${k} is not admin-only`);
});

// Admin-gated outside the security area, on purpose (with the reason).
const ADMIN_ELSEWHERE = new Map([
  ['POST /internal/sandbox-refresh', 'sandbox only (404 elsewhere): replaces the sandbox data with a fresh copy of prod'],
  ['GET /admin/api-tokens', 'internal API keys: on the admin security screen only (owner, 20.11.2026)'],
  ['POST /admin/api-tokens', 'internal API keys: on the admin security screen only (owner, 20.11.2026)'],
  ['POST /admin/api-tokens/:id/revoke', 'internal API keys: on the admin security screen only (owner, 20.11.2026)'],
  ['GET /admin/role-blocks', 'blocking a role of any account (candidate / employer / staff): admins only (owner, 24.11.2026)'],
  ['GET /admin/role-blocks/:userId', 'blocking a role of any account (candidate / employer / staff): admins only (owner, 24.11.2026)'],
  ['PUT /admin/role-blocks/:userId/:role', 'blocking a role of any account (candidate / employer / staff): admins only (owner, 24.11.2026)'],
]);

test('the sandbox refresh is admin-only (it used to be mounted outside the router)', () => {
  assert.deepEqual(gatesOf('POST /internal/sandbox-refresh'), ['admin']);
});

test('every /admin/security, /admin/audit and /admin/staff route is admin-only; nothing else is', () => {
  for (const r of routes) {
    const securityArea = /^\w+ \/admin\/(security|audit|staff)\b/.test(r.key) || ADMIN_ELSEWHERE.has(r.key);
    assert.equal(r.gates.includes('admin'), securityArea, `${r.key}: admin gate ${securityArea ? 'missing' : 'outside the security area'}`);
  }
});

test('the employer area is employer-only, and every /employer route is on that list', () => {
  for (const k of EMPLOYER_ONLY) assert.deepEqual(gatesOf(k), ['employer'], `${k} is not employer-only`);
  const employerRoutes = routes.filter((r) => /^\w+ \/employer\b/.test(r.key)).map((r) => r.key).sort();
  assert.deepEqual(employerRoutes, [...EMPLOYER_ONLY].sort());
  // The employer gate is used nowhere else.
  assert.deepEqual(routes.filter((r) => r.gates.includes('employer') && !EMPLOYER_ONLY.includes(r.key)).map((r) => r.key), []);
});

test('anyAccount opens only the two "add a role to myself" routes; a staff role is never added that way', () => {
  assert.deepEqual(routes.filter((r) => r.gates.includes('account')).map((r) => r.key).sort(), [...ANY_ACCOUNT].sort());
  for (const k of ANY_ACCOUNT) assert.deepEqual(gatesOf(k), ['account'], k);
  assert.ok(!routes.some((r) => /^\w+ \/users\/me\/roles\/(admin|content_manager|placement_coordinator)/.test(r.key)));
});

test('several roles per account: a gate opens on ANY role of the session; staff roles only on Google', async () => {
  const pure = await import('../dist/security/pure.js');
  const enums = await import('../dist/models/enums.js');
  const all = ['user', 'employer', 'content_manager'];
  assert.deepEqual(pure.effectiveRoles(all, 'xhostd'), all);
  for (const m of ['email_code', 'microsoft', 'password', undefined]) assert.deepEqual(pure.effectiveRoles(all, m), ['user', 'employer'], `${m}`);
  assert.deepEqual(pure.effectiveRoles(['admin'], 'email_code'), [], 'a staff-only account has no session but Google');
  assert.equal(pure.hasNonStaffRole(['admin']), false);
  assert.equal(pure.hasNonStaffRole(['admin', 'user']), true);
  assert.equal(enums.primaryRole(['user', 'employer', 'content_manager']), 'content_manager');
  assert.equal(enums.primaryRole(['user', 'employer']), 'employer');
  assert.deepEqual(enums.rolesOf({ role: 'admin' }), ['admin'], 'a row read without roles');
  assert.deepEqual(enums.rolesOf({ roles: ['user', 'admin', 'nonsense'] }), ['admin', 'user']);
  assert.equal(enums.isCandidate({ role: 'admin', roles: ['admin', 'user'] }), true);
  assert.equal(enums.isEmployer({ role: 'content_manager', roles: ['content_manager'] }), false);
  // The gates still list single roles; the middleware admits when any role of the session is on the list.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/middleware/jwtAuthMiddleware.ts', import.meta.url), 'utf8');
  assert.match(src, /user\.roles\.some\(\(r\) => allowedRoles\.includes/);
  // Blocked roles (24.11.2026) never count: the roles are usableRolesOf (DB roles minus admin blocks), then the method.
  assert.match(src, /effectiveRoles\(usableRolesOf\(user\), via\)/);
  assert.match(src, /blocked_roles/);
});

test('no gate but employerOnly admits an employer (never staff, never candidate routes)', async () => {
  const m = await import('../dist/middleware/jwtAuthMiddleware.js');
  for (const g of [m.adminOnly, m.contentManagerOnly, m.staffViewers, m.signedIn, m.staffOnly]) assert.ok(!g.roles.includes('employer'), `${g.gate} admits employers`);
  assert.equal(m.employerOnly.gate, 'employer');
  assert.deepEqual(m.employerOnly.roles, ['employer']);
  const { isStaffRole, REVIEWED_ROLES, ASSIGNABLE_ROLES } = await import('../dist/security/pure.js');
  assert.equal(isStaffRole('employer'), false);
  assert.ok(!REVIEWED_ROLES.includes('employer') && !ASSIGNABLE_ROLES.includes('employer'));
});

test('the gates admit exactly their roles', async () => {
  const { adminOnly, contentManagerOnly, signedIn, staffOnly, staffViewers } = await import('../dist/middleware/jwtAuthMiddleware.js');
  assert.equal(staffViewers.gate, 'staffViewer');
  assert.deepEqual([...staffViewers.roles].sort(), ['admin', 'content_manager', 'placement_coordinator']);
  assert.equal(staffOnly.gate, 'staff');
  assert.deepEqual([...staffOnly.roles].sort(), ['admin', 'content_manager']);
  assert.equal(adminOnly.gate, 'admin');
  assert.deepEqual(adminOnly.roles, ['admin']);
  assert.equal(contentManagerOnly.gate, 'contentManager');
  // An admin can do everything a content manager can (owner, 2026-11-12); a content manager stays content-only.
  assert.deepEqual([...contentManagerOnly.roles].sort(), ['admin', 'content_manager']);
  assert.equal(signedIn.gate, 'signedIn');
  assert.deepEqual([...signedIn.roles].sort(), ['admin', 'content_manager', 'placement_coordinator', 'user']);
  // A coordinator is staff: SSO only, access-reviewed, assignable; not on the API-token screen (staffOnly).
  const { isStaffRole, REVIEWED_ROLES, ASSIGNABLE_ROLES, methodAllowedForRole } = await import('../dist/security/pure.js');
  assert.ok(isStaffRole('placement_coordinator') && REVIEWED_ROLES.includes('placement_coordinator') && ASSIGNABLE_ROLES.includes('placement_coordinator'));
  assert.equal(methodAllowedForRole('email_code', 'placement_coordinator'), false);
  assert.equal(methodAllowedForRole('xhostd', 'placement_coordinator'), true);
  assert.ok(!staffOnly.roles.includes('placement_coordinator'));
  assert.ok(!contentManagerOnly.roles.includes('placement_coordinator') && !adminOnly.roles.includes('placement_coordinator'));
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

test('token management is admin-only (owner, 20.11.2026)', () => {
  for (const k of ['GET /admin/api-tokens', 'POST /admin/api-tokens', 'POST /admin/api-tokens/:id/revoke']) {
    const r = routes.find((x) => x.key === k);
    assert.ok(r, `${k} not found`);
    assert.deepEqual(r.gates, ['admin'], `${k} is not adminOnly`);
  }
  // No route uses the staff gate any more (content managers have no key screen).
  const staffRoutes = routes.filter((r) => r.gates.includes('staff')).map((r) => r.key);
  assert.deepEqual(staffRoutes, [], `staff gate still used: ${staffRoutes}`);
});

test('only an admin issues keys (any scope); content managers, coordinators and everyone else none', async () => {
  const { issuableScopes, PEOPLE_SCOPES, ALL_SCOPES: all } = await import('../dist/internalApi/pure.js');
  assert.deepEqual([...PEOPLE_SCOPES].sort(), ['applications:read', 'candidates:read', 'cvs:read']);
  assert.deepEqual(issuableScopes('content_manager'), []);
  assert.deepEqual(issuableScopes('admin'), all);
  assert.deepEqual(issuableScopes('user'), []);
  assert.deepEqual(issuableScopes('placement_coordinator'), []);
  assert.deepEqual(issuableScopes(undefined), []);
});
