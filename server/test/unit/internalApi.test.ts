// Unit tests for the internal API's pure rules (tokens, scopes, secret, error codes).
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_SCOPES, TOKEN_DAYS, bearerOf, mintToken, missingScopes, parseScopes, salesforceErrorCode, secretMatches, sha256,
  tokenDays, tokenPrefix, tokenState,
} from '../../src/internalApi/pure.js';

test('a minted token has a visible prefix and only its hash is kept', () => {
  const a = mintToken();
  const b = mintToken();
  assert.notEqual(a.token, b.token);
  assert.equal(tokenPrefix(a.token), a.prefix);
  assert.match(a.prefix, /^skzi_[0-9a-f]{8}$/);
  assert.equal(a.hash, sha256(a.token));
  assert.ok(!a.hash.includes(a.token.slice(a.prefix.length + 1)));
  assert.equal(tokenPrefix('skzi_zzzz'), null);
  assert.equal(tokenPrefix(`${a.token}x`), null);
});

test('bearer header parsing', () => {
  assert.equal(bearerOf('Bearer abc'), 'abc');
  assert.equal(bearerOf('bearer  abc '), 'abc');
  assert.equal(bearerOf('Basic abc'), null);
  assert.equal(bearerOf('Bearer a b'), null);
  assert.equal(bearerOf(undefined), null);
});

test('the server secret: constant-time match, off when unset or short', () => {
  const s = 'x'.repeat(40);
  assert.equal(secretMatches(s, s), true);
  assert.equal(secretMatches(`${s}y`, s), false);
  assert.equal(secretMatches('', s), false);
  assert.equal(secretMatches('short', 'short'), false);
  assert.equal(secretMatches(s, undefined), false);
});

test('token lifetime: default 30, max 90, whole days', () => {
  assert.equal(tokenDays(undefined), TOKEN_DAYS.default);
  assert.equal(tokenDays(''), 30);
  assert.equal(tokenDays(90), 90);
  assert.equal(tokenDays('7'), 7);
  assert.equal(tokenDays(91), null);
  assert.equal(tokenDays(0), null);
  assert.equal(tokenDays(1.5), null);
});

test('scopes: known only, de-duplicated, at least one', () => {
  assert.deepEqual(parseScopes(['jobs:read', 'jobs:read']), ['jobs:read']);
  assert.equal(parseScopes([]), null);
  assert.equal(parseScopes(['jobs:read', 'admin']), null);
  assert.equal(parseScopes('jobs:read'), null);
  assert.deepEqual(parseScopes([...ALL_SCOPES].reverse()), ALL_SCOPES);
  assert.deepEqual(missingScopes(['jobs:read'], ['jobs:read', 'cvs:read']), ['cvs:read']);
  assert.deepEqual(missingScopes(ALL_SCOPES, ['cvs:read']), []);
});

test('token state: revoked beats expired', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  assert.equal(tokenState({ expiresAt: new Date('2026-12-01'), revokedAt: null }, now), 'active');
  assert.equal(tokenState({ expiresAt: new Date('2026-11-11T10:00:00Z'), revokedAt: null }, now), 'expired');
  assert.equal(tokenState({ expiresAt: new Date('2026-10-01'), revokedAt: new Date('2026-09-01') }, now), 'revoked');
});

test('Salesforce error codes never carry a response body', () => {
  const body = { response: { status: 400, data: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Email a@b.co is bad' }] } };
  assert.equal(salesforceErrorCode(body), 'http_400_REQUIRED_FIELD_MISSING');
  assert.equal(salesforceErrorCode({ response: { status: 500, data: '<html>a@b.co</html>' } }), 'http_500');
  assert.equal(salesforceErrorCode(new Error('Salesforce authentication failed.')), 'auth');
  assert.equal(salesforceErrorCode({ code: 'ECONNREFUSED' }), 'net_ECONNREFUSED');
  assert.equal(salesforceErrorCode('anything a@b.co'), 'error');
});
