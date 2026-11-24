// Security review 24.11.2026, M3: the lasting lists have their own key; the legacy key still matches old rows and links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, addressKeys, legacyAddressKey, unsubscribeSecrets, addressKeyWarning, hasDedicatedKey } from '../../src/security/addressKey.ts';
import { emailKey } from '../../src/security/emailCode.ts';
import { unsubscribeToken, verifyUnsubscribeToken } from '../../src/security/marketing.ts';

const OLD = { EMAIL_CODE_SECRET: 'code-secret-0123456789', ACCESS_TOKEN_SECRET: 'jwt-0123456789' };
const NEW = { ...OLD, MARKETING_OPTOUT_SECRET: 'm'.repeat(40) };

test('without the dedicated secret nothing changes (the legacy key = emailKey), with a warning', () => {
  assert.equal(addressKey('A@x.test', OLD), emailKey('a@x.test', OLD));
  assert.deepEqual(addressKeys('a@x.test', OLD), [emailKey('a@x.test', OLD)]);
  assert.equal(hasDedicatedKey(OLD), false);
  assert.match(String(addressKeyWarning(OLD)), /not set/);
  assert.match(String(addressKeyWarning({ ...OLD, MARKETING_OPTOUT_SECRET: 'short' })), /shorter/);
});

test('with it: new rows get the dedicated key, lookups also try the legacy one; JWT secrets no longer matter', () => {
  const k = addressKey('a@x.test', NEW);
  assert.notEqual(k, emailKey('a@x.test', NEW));
  assert.deepEqual(addressKeys('a@x.test', NEW), [k, legacyAddressKey('a@x.test', NEW)]);
  assert.equal(addressKeyWarning(NEW), null);
  // Rotating the sign-in / JWT secrets leaves the key as it is.
  assert.equal(addressKey('a@x.test', { ...NEW, ACCESS_TOKEN_SECRET: 'rotated', EMAIL_CODE_SECRET: 'rotated' }), k);
  // The legacy material can be pinned before rotating them.
  assert.equal(legacyAddressKey('a@x.test', { MARKETING_OPTOUT_LEGACY_SECRET: OLD.EMAIL_CODE_SECRET, EMAIL_CODE_SECRET: 'rotated' }),
    emailKey('a@x.test', OLD));
});

test('unsubscribe links: signed with the dedicated key; a link signed before still verifies; a forged one never', () => {
  const p = { k: addressKey('a@x.test', NEW) };
  assert.deepEqual(verifyUnsubscribeToken(unsubscribeToken(p, NEW), NEW), p);
  const old = unsubscribeToken({ k: emailKey('a@x.test', OLD) }, OLD);
  assert.deepEqual(verifyUnsubscribeToken(old, NEW), { k: emailKey('a@x.test', OLD) }, 'an old link still works');
  assert.equal(verifyUnsubscribeToken(unsubscribeToken(p, { MARKETING_OPTOUT_SECRET: 'x'.repeat(40) }), NEW), null);
  assert.equal(unsubscribeSecrets(NEW).length, 2);
});
