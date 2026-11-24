// Unit tests for the activity-log sign-in rules (security/pure.ts, security/audit.ts uploadRef): the device summary,
// the address form, the unusual-sign-in thresholds. The DB parts are in test/e2e-activity-log.mjs.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RESET_TOKEN_SECRET = 'unit-test-secret-0123456789abcdef';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // never connected here

const { SIGNIN_ALERTS, SIGNIN_FAILURE_ACTIONS, deviceSummary, normalizeIp, isNewSigninAddress, reachedBurst } = await import('../../src/security/pure.js');
const { uploadRef } = await import('../../src/security/audit.js');

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  samsungAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

test('device summary: browser and OS family only', () => {
  assert.equal(deviceSummary(UA.chromeWin), 'Chrome · Windows');
  assert.equal(deviceSummary(UA.edgeWin), 'Edge · Windows');
  assert.equal(deviceSummary(UA.safariIphone), 'Safari · iOS');
  assert.equal(deviceSummary(UA.chromeIphone), 'Chrome · iOS');
  assert.equal(deviceSummary(UA.firefoxMac), 'Firefox · macOS');
  assert.equal(deviceSummary(UA.safariMac), 'Safari · macOS');
  assert.equal(deviceSummary(UA.samsungAndroid), 'Samsung Internet · Android');
  assert.equal(deviceSummary(UA.chromeAndroid), 'Chrome · Android');
  assert.equal(deviceSummary(UA.firefoxLinux), 'Firefox · Linux');
  assert.equal(deviceSummary(UA.chromeOs), 'Chrome · ChromeOS');
});

test('device summary: scripts, empty and odd values; never a version or the full string', () => {
  assert.equal(deviceSummary('curl/8.4.0'), 'script');
  assert.equal(deviceSummary('python-requests/2.31'), 'script');
  assert.equal(deviceSummary('node'), 'script');
  assert.equal(deviceSummary('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'script');
  assert.equal(deviceSummary(''), 'unknown');
  assert.equal(deviceSummary(undefined), 'unknown');
  assert.equal(deviceSummary(42), 'unknown');
  assert.equal(deviceSummary('SomethingElse/1.0'), 'other · other');
  for (const ua of Object.values(UA)) {
    const d = deviceSummary(ua);
    assert.ok(!/\d/.test(d), `no version numbers: ${d}`);
    assert.ok(d.length <= 30, `short: ${d}`);
  }
});

test('address: IPv4-mapped IPv6 → IPv4, trimmed, capped, empty when unknown', () => {
  assert.equal(normalizeIp('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp(' 203.0.113.9 '), '203.0.113.9');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp('x'.repeat(100)).length, 64);
});

test('new address: only when the account already has a history of addresses', () => {
  assert.equal(isNewSigninAddress('1.1.1.1', []), false, 'first address ever is not news (entries before the change carry none)');
  assert.equal(isNewSigninAddress('1.1.1.1', ['1.1.1.1']), false);
  assert.equal(isNewSigninAddress('2.2.2.2', ['1.1.1.1']), true);
  assert.equal(isNewSigninAddress('2.2.2.2', ['1.1.1.1', '2.2.2.2']), false);
  assert.equal(isNewSigninAddress('', ['1.1.1.1']), false, 'unknown address: no alert');
  assert.equal(isNewSigninAddress('2.2.2.2', ['', null as any]), false, 'empty history entries do not count');
});

test('bursts: at the threshold and above, never with a zero limit', () => {
  const f = SIGNIN_ALERTS.staffFailures.count;
  assert.equal(reachedBurst(f - 1, f), false);
  assert.equal(reachedBurst(f, f), true);
  assert.equal(reachedBurst(f + 3, f), true);
  assert.equal(reachedBurst(5, 0), false);
  const a = SIGNIN_ALERTS.accountsPerAddress.count;
  assert.equal(reachedBurst(a - 1, a), false);
  assert.equal(reachedBurst(a, a), true);
});

test('thresholds are the ones docs/security.md quotes', () => {
  assert.deepEqual(SIGNIN_ALERTS, { staffFailures: { count: 5, windowMinutes: 15 }, accountsPerAddress: { count: 10, windowMinutes: 60 } });
  for (const a of ['auth.oauth_failed', 'auth.email_code_refused_staff', 'auth.login_refused_deactivated']) assert.ok(SIGNIN_FAILURE_ACTIONS.includes(a), a);
  assert.ok(!SIGNIN_FAILURE_ACTIONS.includes('auth.login'));
});

test('upload ref: a stable keyed hash, never the key or the file name', () => {
  const key = 'post-scan/abcdef0123456789abcdef0123456789/Dana_Levi_CV.pdf';
  const r = uploadRef(key);
  assert.match(r, /^upload#[0-9a-f]{12}$/);
  assert.equal(uploadRef(key), r, 'same file, same ref (upload ↔ attach)');
  assert.notEqual(uploadRef(key + 'x'), r);
  assert.ok(!r.includes('Dana') && !r.includes('abcdef0123'));
});
