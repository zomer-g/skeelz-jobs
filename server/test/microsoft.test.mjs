// "Continue with Microsoft" token checks (no DB): config off by default and dev overrides only with DEV_MODE, the ID
// token verifier (issuer of the token's own tenant, audience = client id, nonce, expiry, key, alg, forged tid) and the
// verified-email rule (personal: email; work/school: email only with xms_edov true; never preferred_username/upn).
// Run: npx tsc && npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMockIdp } from './helpers/mockIdp.mjs';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
const ms = await import('../dist/security/microsoft.js');
const oidc = await import('../dist/security/oidc.js');
const pure = await import('../dist/security/pure.js');
const { microsoftConfig } = await import('../dist/config/ssoConfig.js');

const idp = await startMockIdp();
after(() => idp.close());

const CLIENT = '11111111-2222-3333-4444-555555555555';
const WORK_TID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PERSONAL = ms.PERSONAL_ACCOUNTS_TENANT;
const NONCE = 'nonce-abc';
const iss = (tid) => `${idp.issuer}/${tid}/v2.0`;
const token = (claims = {}, opts) => idp.sign({ iss: iss(WORK_TID), aud: CLIENT, tid: WORK_TID, sub: 'sub-1', nonce: NONCE, ...claims }, opts);
const verify = (tok, o = {}) => ms.verifyMicrosoftIdToken(tok, { jwksUrl: idp.jwksUrl, loginBase: idp.issuer, clientId: CLIENT, nonce: NONCE, ...o });
const rejects = (tok, reason, o) => assert.rejects(verify(tok, o), (e) => e instanceof oidc.OidcError && e.reason === reason);

test('Microsoft sign-in is off unless enabled AND both client id and secret are set; mock base only in DEV_MODE', () => {
  const saved = { ...process.env };
  try {
    delete process.env.ENABLE_MICROSOFT_SSO; process.env.MS_CLIENT_ID = CLIENT; process.env.MS_CLIENT_SECRET = 's';
    assert.equal(microsoftConfig().enabled, false);
    process.env.ENABLE_MICROSOFT_SSO = 'true';
    assert.equal(microsoftConfig().enabled, true);
    delete process.env.MS_CLIENT_SECRET;
    assert.equal(microsoftConfig().enabled, false);
    process.env.MS_CLIENT_SECRET = 's'; process.env.MS_CLIENT_ID = '';
    assert.equal(microsoftConfig().enabled, false);
    process.env.DEV_MODE = 'false'; process.env.MS_LOGIN_BASE = 'http://evil';
    const c = microsoftConfig();
    assert.equal(c.authorizeUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    assert.equal(c.tokenUrl, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    assert.equal(c.jwksUrl, 'https://login.microsoftonline.com/common/discovery/v2.0/keys');
    assert.equal(c.scope, 'openid email profile');
    process.env.DEV_MODE = 'true';
    assert.equal(microsoftConfig().tokenUrl, 'http://evil/common/oauth2/v2.0/token');
  } finally {
    process.env = saved;
  }
});

test('a Microsoft session never counts for staff', () => {
  for (const role of pure.STAFF_ROLES) assert.equal(pure.methodAllowedForRole('microsoft', role), false);
  assert.equal(pure.methodAllowedForRole('microsoft', 'user'), true);
});

test('ID token: a good one is accepted (work and personal tenants)', async () => {
  assert.equal((await verify(token())).sub, 'sub-1');
  assert.equal((await verify(token({ iss: iss(PERSONAL), tid: PERSONAL }))).tid, PERSONAL);
});

test('ID token: wrong audience, issuer, tenant, nonce, expiry are refused', async () => {
  await rejects(token({ aud: 'someone-else' }), 'invalid_token');
  await rejects(token({ aud: [CLIENT, 'other'] }), 'bad_audience');
  await rejects(token({ iss: 'https://evil/v2.0' }), 'invalid_token');
  // iss of another tenant than the token's tid (one tenant's token passed off as another's)
  await rejects(token({ iss: iss(PERSONAL) }), 'invalid_token');
  await rejects(token({ tid: 'not-a-guid' }), 'bad_tenant');
  await rejects(token({ tid: undefined }), 'bad_tenant');
  await rejects(token({ nonce: 'other' }), 'nonce');
  await rejects(token({ nonce: undefined }), 'nonce');
  await rejects(token(), 'missing_token', { nonce: '' });
  const now = Math.floor(Date.now() / 1000);
  await rejects(token({ exp: now - 120, iat: now - 700 }), 'expired');
  await rejects('', 'missing_token');
});

test('ID token: other keys, algorithms and unsigned tokens are refused', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejects(token({}, { key: other }), 'invalid_token');
  await rejects(token({}, { kid: 'unknown-kid' }), 'unknown_kid');
  await rejects(token({}, { alg: 'HS256', key: 'secret' }), 'bad_header');
  await rejects(token({}, { alg: 'none' }), 'bad_header');
  // A tampered payload (tid swapped after signing) fails the signature.
  const [h, , sig] = token().split('.');
  const forged = Buffer.from(JSON.stringify({ iss: iss(PERSONAL), aud: CLIENT, tid: PERSONAL, sub: 'x', nonce: NONCE, exp: 9999999999 })).toString('base64url');
  await rejects(`${h}.${forged}.${sig}`, 'invalid_token');
});

test('verified email: personal accounts use the email claim', () => {
  const r = ms.microsoftIdentity({ tid: PERSONAL, sub: 'abc', email: ' Someone@Outlook.com ', name: 'Some One' });
  assert.deepEqual(r, { ok: true, key: `${PERSONAL}:abc`, email: 'someone@outlook.com', name: 'Some One', personal: true });
});

test('verified email: work/school accounts only with xms_edov true', () => {
  const base = { tid: WORK_TID, sub: 'w1', email: 'a@corp.example' };
  assert.equal(ms.microsoftIdentity({ ...base, xms_edov: true }).ok, true);
  assert.equal(ms.microsoftIdentity({ ...base, xms_edov: 'true' }).ok, true);
  for (const edov of [undefined, false, 'false', 0, 1, '1']) {
    assert.deepEqual(ms.microsoftIdentity({ ...base, xms_edov: edov }), { ok: false, reason: 'unverified_email' }, String(edov));
  }
});

test('verified email: preferred_username / upn are never used', () => {
  for (const tid of [PERSONAL, WORK_TID]) {
    const r = ms.microsoftIdentity({ tid, sub: 'x', preferred_username: 'admin@victim.example', upn: 'admin@victim.example', xms_edov: true });
    assert.deepEqual(r, { ok: false, reason: 'no_email' });
  }
  assert.deepEqual(ms.microsoftIdentity({ tid: PERSONAL, sub: 'x', email: 'not-an-email' }), { ok: false, reason: 'no_email' });
});

test('PKCE challenge is S256 base64url of the verifier (RFC 7636 appendix B)', () => {
  assert.equal(ms.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
