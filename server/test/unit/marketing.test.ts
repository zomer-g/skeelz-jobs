// Marketing consent states and the unsubscribe token (security/marketing.ts).
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarketingStatus, marketingStatus, mayReceiveMarketing, SOURCE_OF_VIA, unsubscribeToken, verifyUnsubscribeToken } from '../../src/security/marketing.js';
import { emailKey } from '../../src/security/emailCode.js';

const ENV = { EMAIL_CODE_SECRET: 'unit-test-secret-0123456789' };

test('states: a removal wins over any answer; otherwise the latest answer, or unknown', () => {
  assert.equal(marketingStatus(true, null), 'agreed');
  assert.equal(marketingStatus(false, null), 'not_agreed');
  assert.equal(marketingStatus(null, null), 'unknown');
  assert.equal(marketingStatus(undefined, undefined), 'unknown');
  assert.equal(marketingStatus(true, new Date()), 'removed', 'a removal beats an earlier yes');
  assert.equal(marketingStatus(null, '2026-11-23T10:00:00Z'), 'removed');
  assert.equal(mayReceiveMarketing(true, null), true);
  assert.equal(mayReceiveMarketing(true, new Date()), false);
  assert.equal(mayReceiveMarketing(null, null), false);
  assert.ok(isMarketingStatus('removed') && !isMarketingStatus('yes') && !isMarketingStatus(undefined));
  assert.deepEqual(Object.keys(SOURCE_OF_VIA).sort(), ['complaint', 'link', 'personal_area', 'staff']);
});

test('unsubscribe token: signed, carries a keyed hash (never the address), tamper-proof', () => {
  const k = emailKey('someone@example.com', ENV);
  const u = 'a'.repeat(24);
  const t = unsubscribeToken({ k, u }, ENV);
  assert.ok(!t.includes('someone') && !Buffer.from(t.split('.')[0], 'base64url').toString().includes('@'));
  assert.deepEqual(verifyUnsubscribeToken(t, ENV), { k, u });
  assert.deepEqual(verifyUnsubscribeToken(unsubscribeToken({ k }, ENV), ENV), { k });
  assert.equal(verifyUnsubscribeToken(t, { EMAIL_CODE_SECRET: 'another-secret-xxxxxxxxxx' }), null, 'other secret');
  const [body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ k: emailKey('victim@example.com', ENV), u })).toString('base64url');
  assert.equal(verifyUnsubscribeToken(`${forged}.${mac}`, ENV), null, 'changed body');
  assert.equal(verifyUnsubscribeToken(`${body}.${mac}x`, ENV), null);
  assert.equal(verifyUnsubscribeToken(`${body}.${mac}.x`, ENV), null);
  for (const bad of [undefined, null, '', 'x', 'a.b', 42, 'x'.repeat(700)]) assert.equal(verifyUnsubscribeToken(bad, ENV), null, String(bad));
  // A well-signed token with a bad shape is refused too.
  const odd = Buffer.from(JSON.stringify({ k: 'not-a-hash' })).toString('base64url');
  const oddMac = crypto.createHmac('sha256', `${ENV.EMAIL_CODE_SECRET}:marketing-unsubscribe`).update(odd).digest('base64url');
  assert.equal(verifyUnsubscribeToken(`${odd}.${oddMac}`, ENV), null);
});
