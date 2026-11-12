// Sign-in rules and token checks (no DB): who may sign in how, return paths, and the RS256 verifier for xhostd SSO
// against a mock JWKS (wrong audience / issuer / key / alg, expiry, key rotation). Run: npx tsc && npm test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startMockIdp } from './helpers/mockIdp.mjs';

process.env.ACCESS_TOKEN_SECRET ||= 'test'; process.env.REFRESH_TOKEN_SECRET ||= 'test'; process.env.RESET_TOKEN_SECRET ||= 'test';
const pure = await import('../dist/security/pure.js');
const oidc = await import('../dist/security/oidc.js');
const sso = await import('../dist/config/ssoConfig.js');

const idp = await startMockIdp();
after(() => idp.close());

test('staff roles: one list, includes admin and content manager, not candidates', () => {
  assert.equal(pure.isStaffRole('admin'), true);
  assert.equal(pure.isStaffRole('content_manager'), true);
  assert.equal(pure.isStaffRole('user'), false);
  assert.equal(pure.isStaffRole(''), false);
  assert.equal(pure.isStaffRole(undefined), false);
});

test('staff sessions count only when made with xhostd SSO', () => {
  for (const role of pure.STAFF_ROLES) {
    assert.equal(pure.methodAllowedForRole('xhostd', role), true);
    for (const m of ['password', 'google', undefined, '']) assert.equal(pure.methodAllowedForRole(m, role), false, `${role} via ${m}`);
  }
  for (const m of ['password', 'xhostd', undefined]) assert.equal(pure.methodAllowedForRole(m, 'user'), true);
});

test('return paths stay on this site and off the API', () => {
  assert.equal(pure.safeReturnPath('/job/abc?x=1'), '/job/abc?x=1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '', null, '/api/auth/session', '/xhost-auth/logout', '/a\nb']) {
    assert.equal(pure.safeReturnPath(bad), '/', String(bad));
  }
  assert.equal(pure.withQueryParam('/a?b=1#h', 'signin', 'ok'), '/a?b=1&signin=ok#h');
  assert.equal(pure.withQueryParam('/', 'signin_error', 'not staff'), '/?signin_error=not%20staff');
});

test('request host for the identity cookie aud: no port, lowercase', () => {
  assert.equal(pure.requestHost('Jobs.Skeelz.co.il:443'), 'jobs.skeelz.co.il');
  assert.equal(pure.requestHost('localhost:3100'), 'localhost');
  assert.equal(pure.requestHost(undefined), '');
});

test('xhostd SSO is off unless enabled; test overrides are ignored outside DEV_MODE', () => {
  const saved = { ...process.env };
  try {
    delete process.env.SSO_ENABLED;
    assert.equal(sso.xhostdConfig().enabled, false);
    process.env.SSO_ENABLED = 'true';
    assert.equal(sso.xhostdConfig().enabled, true);
    process.env.DEV_MODE = 'false';
    process.env.SSO_ISSUER = 'http://evil'; process.env.SSO_JWKS_URL = 'http://evil/jwks'; process.env.SSO_LOGIN_URL = 'http://evil/login';
    assert.equal(sso.xhostdConfig().issuer, 'https://auth.xhostd.com');
    assert.equal(sso.xhostdConfig().jwksUrl, 'https://auth.xhostd.com/xhost-auth/jwks');
    assert.equal(sso.xhostdConfig().loginUrl, '/xhost-auth/login');
    process.env.DEV_MODE = 'true';
    assert.equal(sso.xhostdConfig().issuer, 'http://evil');
  } finally {
    process.env = saved;
  }
});

test('staff roles are the reviewed roles (one list)', () => {
  assert.deepEqual([...pure.STAFF_ROLES], [...pure.REVIEWED_ROLES]);
});

const opts = () => ({ jwksUrl: idp.jwksUrl, issuers: [idp.issuer], audience: 'jobs.example.test' });
const rejects = (tok, reason, o = opts()) => assert.rejects(oidc.verifyRs256(tok, o), (e) => e instanceof oidc.OidcError && e.reason === reason);

test('RS256 verifier accepts a good token', async () => {
  const c = await oidc.verifyRs256(idp.sign({ aud: 'jobs.example.test', sub: '123', email: 'a@b.test' }), opts());
  assert.equal(c.sub, '123');
});

test('RS256 verifier refuses wrong audience, issuer, expiry, missing sub', async () => {
  await rejects(idp.sign({ aud: 'other.example.test', sub: '1' }), 'invalid_token');
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1', iss: 'https://evil' }), 'invalid_token');
  const past = Math.floor(Date.now() / 1000) - 3600;
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1', iat: past - 60, exp: past }), 'expired');
  await rejects(idp.sign({ aud: 'jobs.example.test' }), 'missing_claims');
  await rejects('', 'missing_token');
});

test('RS256 verifier: the token cannot choose its algorithm or key', async () => {
  // alg confusion: HS256 "signed" with the public key, and alg=none.
  const pubPem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1' }, { alg: 'HS256', key: pubPem }), 'bad_header');
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1' }, { alg: 'none' }), 'bad_header');
  // A key the provider never published (forged with another RSA key under the provider's kid).
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1' }, { key: other }), 'invalid_token');
  await rejects(idp.sign({ aud: 'jobs.example.test', sub: '1' }, { kid: 'unknown-kid' }), 'unknown_kid');
});

test('flow cookie: signed, provider-bound', () => {
  const v = oidc.signFlow('google', { s: 'abc', r: '/' });
  assert.equal(oidc.readFlow('google', v).s, 'abc');
  assert.equal(oidc.readFlow('xhostd', v), null, 'a Google flow cookie is no xhostd flow cookie');
  assert.equal(oidc.readFlow('google', v.slice(0, -2) + 'xx'), null);
  assert.equal(oidc.sameValue('abc', 'abc'), true);
  assert.equal(oidc.sameValue('abc', 'abd'), false);
  assert.equal(oidc.sameValue('', ''), false);
  assert.equal(oidc.sameValue(undefined, undefined), false);
});
