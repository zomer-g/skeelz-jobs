// Unit tests for the 2026-11 security fixes (pure parts; the DB parts are in the e2e suites).
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ACCESS_TOKEN_SECRET = 'same-secret-on-purpose-0123456789abcdef';
process.env.REFRESH_TOKEN_SECRET = 'same-secret-on-purpose-0123456789abcdef';
process.env.RESET_TOKEN_SECRET = 'same-secret-on-purpose-0123456789abcdef';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // never connected here

const { issuerRefusal, ALL_SCOPES } = await import('../../src/internalApi/pure.js');
const { rowToJob } = await import('../../src/dal/jobDAL.js');
const { DEFAULT_APPLY_POLICY } = await import('../../src/models/schemas/applyPolicy.js');
const { typedEmailRef } = await import('../../src/security/audit.js');
const tokens = await import('../../src/services/tokenUtilityService.js');
const { jwtSecretProblems } = await import('../../src/utils/envChecker.js');
const { sanitizeUrl, sanitizeReferrer } = await import('../../../client/src/utils/analyticsPolicy.ts');

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 1. internal API keys stand only while their issuer does ----
test('a deactivated issuer\'s key is refused', () => {
  assert.equal(issuerRefusal({ role: 'content_manager', deactivatedAt: new Date() }, ['jobs:read']), 'issuer_inactive');
});
test('a key whose issuer is now a candidate (or unknown) is refused; an active issuer\'s key passes', () => {
  assert.equal(issuerRefusal({ role: 'user', deactivatedAt: null }, ['candidates:read']), 'issuer_role');
  assert.equal(issuerRefusal(null, ['jobs:read']), 'issuer_unknown');
  assert.equal(issuerRefusal({ role: null, deactivatedAt: null }, ['jobs:read']), 'issuer_unknown');
  assert.equal(issuerRefusal({ role: 'admin', deactivatedAt: null }, ALL_SCOPES), null);
  assert.equal(issuerRefusal({ role: 'admin', deactivatedAt: null }, ['candidates:read', 'cvs:read']), null);
  // Only admins issue keys (owner, 20.11.2026): a content manager's old key no longer passes.
  assert.equal(issuerRefusal({ role: 'content_manager', deactivatedAt: null }, ['jobs:read']), 'issuer_role');
});

// ---- 4. no contact details or uploadBy in the site's lists ----
const ROW = {
  id: '0123456789abcdef01234567', title: 'T', job_scope: [], company_name: 'C', publish_date: new Date(), city_symbol: 1,
  description: 'd', job_id: 7, contact_person_name: 'Dana', contact_person_phone: '0521234567',
  contact_person_email: 'dana@example.com', upload_by: 'staff@example.com', status: 'Active', required_skills: [],
  skills_map: {}, is_sponsored: false, is_marked: false, is_public: true,
};
const SELF = { ...DEFAULT_APPLY_POLICY, guestMode: 'self' as const };
const hasContact = (j: any) => ['contactPersonName', 'contactPersonPhone', 'contactPersonEmail'].some((k) => k in j && j[k] !== undefined);

test('a listed job (board, map, page data) carries no contact details and no uploadBy, even on a self-apply job', () => {
  for (const defaults of [DEFAULT_APPLY_POLICY, SELF]) {
    const j: any = rowToJob({ ...ROW }, { applyDefaults: defaults as any });
    assert.ok(!hasContact(j), 'contact details in a list');
    assert.ok(!('uploadBy' in j) || j.uploadBy === undefined, 'uploadBy in a list');
  }
});
test('one job: contact details only on a self-apply job; staff see them and uploadBy', () => {
  assert.ok(hasContact(rowToJob({ ...ROW }, { withContacts: true, applyDefaults: SELF as any })));
  assert.ok(!hasContact(rowToJob({ ...ROW }, { withContacts: true, applyDefaults: DEFAULT_APPLY_POLICY as any })));
  const staff: any = rowToJob({ ...ROW }, { withComments: true, applyDefaults: DEFAULT_APPLY_POLICY as any });
  assert.ok(hasContact(staff));
  assert.equal(staff.uploadBy, 'staff@example.com');
});

// ---- 5a. the typed email is never in the log ----
test('a typed email is logged as user:<id> or a short keyed hash, never the address', () => {
  assert.equal(typedEmailRef('Dana@Example.com', '0123456789abcdef01234567'), 'user:0123456789abcdef01234567');
  const h = typedEmailRef('dana.cohen@example.com', null);
  assert.match(h, /^email#[0-9a-f]{12}$/);
  assert.ok(!h.includes('dana') && !h.includes('example'));
  assert.equal(typedEmailRef(' DANA.COHEN@example.com ', null), h, 'the same address gives the same value');
  assert.notEqual(typedEmailRef('other@example.com', null), h);
});

// ---- 12. typ claim: one kind of token is never accepted as another (even with equal secrets) ----
test('access and refresh tokens carry typ and are checked for it', () => {
  const p = { userID: '0123456789abcdef01234567', userRole: 'user' } as any;
  const access = tokens.generateAccessToken(p);
  const refresh = tokens.generateRefreshToken(p);
  assert.equal((tokens.verifyAccessToken(access) as any).typ, 'access');
  assert.equal((tokens.verifyRefreshToken(refresh) as any).typ, 'refresh');
  assert.throws(() => tokens.verifyRefreshToken(access));
  assert.throws(() => tokens.verifyAccessToken(refresh));
});

test('envChecker: JWT secrets must be 32+ characters and all different', () => {
  assert.deepEqual(jwtSecretProblems({ ACCESS_TOKEN_SECRET: 'a'.repeat(32), REFRESH_TOKEN_SECRET: 'b'.repeat(32), RESET_TOKEN_SECRET: 'c'.repeat(40) }), []);
  assert.ok(jwtSecretProblems({ ACCESS_TOKEN_SECRET: 'short', REFRESH_TOKEN_SECRET: 'b'.repeat(32), RESET_TOKEN_SECRET: 'c'.repeat(32) }).some((p) => /ACCESS_TOKEN_SECRET/.test(p)));
  assert.ok(jwtSecretProblems({ ACCESS_TOKEN_SECRET: 'a'.repeat(32), REFRESH_TOKEN_SECRET: 'a'.repeat(32), RESET_TOKEN_SECRET: 'c'.repeat(32) }).some((p) => /different/.test(p)));
});

// ---- 10. the server's pre-GTM URL sanitizer = the client's sanitizer ----
test('the page_location / page_referrer set before GTM loads are sanitized like the client does', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'index.ts'), 'utf8');
  const start = src.indexOf('export const URL_SANITIZER_JS =');
  const expr = src.slice(start + 'export const URL_SANITIZER_JS ='.length, src.indexOf("}`;", start) + 2);
  const js = new Function(`return ${expr.trim()}`)() as string;
  const fns = new Function(`${js}; return { url: __skzUrl, ref: __skzRef };`)() as { url: (h: string) => string; ref: (r: string) => string };
  const urls = [
    'https://jobs.example.org/', 'https://jobs.example.org/job/0123456789abcdef01234567?utm_source=mail&utm_campaign=nov',
    'https://jobs.example.org/?token=eyJhbGciOiJIUzI1NiJ9.x.y', 'https://jobs.example.org/?searchValue=%D7%93%D7%A0%D7%94&view=map',
    'https://jobs.example.org/reset/dana.cohen@example.com', 'https://jobs.example.org/u/0521234567',
    'https://jobs.example.org/a%20b/%E0%A4', 'https://jobs.example.org/?utm_source=0521234567',
  ];
  for (const u of urls) assert.equal(fns.url(u), sanitizeUrl(u), u);
  for (const r of ['', 'https://www.google.com/search?q=dana', 'not a url']) assert.equal(fns.ref(r), sanitizeReferrer(r), r);
  assert.ok(!fns.url(urls[2]).includes('token'));
  // Set before any Google script is injected.
  const snippet = src.slice(src.indexOf('const analyticsSnippet'), src.indexOf('const contentSecurityPolicy'));
  const ret = snippet.slice(snippet.indexOf('return `<script'));
  assert.ok(ret.indexOf("gtag('set',{page_location:") > 0 && ret.indexOf("gtag('set',{page_location:") < ret.indexOf('window.__skeelzLoadAnalytics=function'));
});

// ---- security review 24.11.2026 (M1, M4) ------------------------------------------------------------------------
test('M1: no live code checks the candidate role with role = \'user\' (several roles per account)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(import.meta.dirname, '..', '..', 'src');
  for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
    // One-time migrations in db.ts already ran in production; widening them would change what they deleted.
    if (!f.endsWith('.ts') || /config[\\/]db\.ts$/.test(f)) continue;
    // The one allowed form: the roles set first, `role` only for a row read without it (pure.ts profileIncomplete).
    const s = fs.readFileSync(path.join(root, f), 'utf8').replace("u.roles?.length ? u.roles.includes('user') : u.role === 'user'", '');
    assert.ok(!/\brole\s*(=|<>|!=)\s*'(user|employer)'/.test(s), `${f}: SQL role = 'user' / 'employer'`);
    assert.ok(!/\.role\s*(===|!==)\s*'user'/.test(s), `${f}: .role === 'user'`);
  }
});

test('M4: a failed webhook handling releases the message id, so Resend\'s retry is handled', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const s = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'controllers', 'mailController.ts'), 'utf8');
  const handler = s.slice(s.indexOf('export const resendWebhook'));
  assert.match(handler, /claimed = true/);
  assert.match(handler, /catch \(e\) \{[\s\S]{0,200}if \(claimed\) await mail\.releaseDelivery\(svixId\)/);
});
