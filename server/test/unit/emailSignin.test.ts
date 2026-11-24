// Sign-in by a code sent by email: security/emailCode.ts (hashing, expiry, tries, limits, neutral answers) and
// services/emailService.ts (Resend call; nothing personal in the console).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_CODE, NEUTRAL_REQUEST_ANSWER, emailCodeEnabled, attemptsLeft, checkCode, cleanCode, emailKey, generateCode, hashCode, isValidEmail,
  normalizeEmail, requestRefusal, sameHash, sendRefusal, signInCodeEmail,
} from '../../src/security/emailCode.ts';
import { deliver, rtlHtml, sendEmail, EmailSendError, RESEND_URL, _setFetchForTests } from '../../src/services/emailService.ts';
import { isStaffRole } from '../../src/security/pure.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { EMAIL_CODE_SECRET: 'unit-test-secret-0123456789' };

test('the numbers: 6 digits, 10 minutes, 5 tries, 60 s between codes', () => {
  assert.equal(EMAIL_CODE.digits, 6);
  assert.equal(EMAIL_CODE.ttlMinutes, 10);
  assert.equal(EMAIL_CODE.maxAttempts, 5);
  assert.equal(EMAIL_CODE.resendSeconds, 60);
});

test('the feature switch is off unless EMAIL_CODE_SIGNIN_ENABLED is exactly "true"; every route checks it first', () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) assert.equal(emailCodeEnabled({ EMAIL_CODE_SIGNIN_ENABLED: v }), false, String(v));
  assert.equal(emailCodeEnabled({ EMAIL_CODE_SIGNIN_ENABLED: 'true' }), true);
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'controllers', 'emailSigninController.ts'), 'utf8');
  for (const fn of ['requestCode', 'verifyCode', 'completeSignup', 'devMintCode']) {
    const body = src.slice(src.indexOf(`export const ${fn}`));
    const firstAwait = body.search(/await |res\.json\(/);
    assert.ok(body.indexOf('refuseIfOff(res)') > 0 && body.indexOf('refuseIfOff(res)') < firstAwait, `${fn} must check the switch first`);
  }
});

test('codes are 6 random digits, leading zeros kept', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 1990, 'codes repeat too often');
  assert.equal(cleanCode(' 012 345 '), '012345');
  assert.equal(cleanCode('012-345'), '012345');
  for (const bad of ['12345', '1234567', 'abcdef', '', null, undefined, 123456]) {
    assert.equal(cleanCode(bad), bad === 123456 ? '123456' : null, String(bad));
  }
});

test('hashing: keyed, bound to the address, never the address or the code in clear', () => {
  const k = emailKey(' Dana.Cohen@Example.com ', env);
  assert.equal(k, emailKey('dana.cohen@example.com', env), 'normalised');
  assert.notEqual(k, emailKey('other@example.com', env));
  assert.notEqual(k, emailKey('dana.cohen@example.com', { EMAIL_CODE_SECRET: 'another-secret-0123456789' }), 'keyed');
  assert.ok(!k.includes('dana') && !k.includes('example'));
  const h = hashCode(k, '123456', env);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('123456'));
  assert.notEqual(h, hashCode(emailKey('other@example.com', env), '123456', env), 'a code is bound to its address');
  assert.ok(sameHash(h, hashCode(k, '123456', env)));
  assert.ok(!sameHash(h, hashCode(k, '123457', env)));
  assert.ok(!sameHash(h, ''), 'empty never matches');
});

const now = new Date('2026-11-14T10:00:00Z');
const row = (o: Partial<{ code: string; expires_at: Date; attempts: number; used_at: Date | null }> = {}) => {
  const k = emailKey('a@example.com', env);
  return { code_hash: hashCode(k, o.code ?? '111111', env), expires_at: o.expires_at ?? new Date(now.getTime() + 60_000),
    attempts: o.attempts ?? 0, used_at: o.used_at ?? null, k };
};

test('checkCode: right, wrong, expired, used, out of tries, none', () => {
  const r = row();
  assert.equal(checkCode(r, hashCode(r.k, '111111', env), now), 'ok');
  assert.equal(checkCode(r, hashCode(r.k, '111112', env), now), 'wrong');
  assert.equal(checkCode(row({ expires_at: now }), hashCode(r.k, '111111', env), now), 'expired', 'expires at the 10th minute');
  assert.equal(checkCode(row({ expires_at: new Date(now.getTime() - 1) }), hashCode(r.k, '111111', env), now), 'expired');
  assert.equal(checkCode(row({ used_at: now }), hashCode(r.k, '111111', env), now), 'used', 'single use');
  assert.equal(checkCode(row({ attempts: 5 }), hashCode(r.k, '111111', env), now), 'locked', 'the right code after 5 tries is refused');
  assert.equal(checkCode(row({ attempts: 4 }), hashCode(r.k, '111111', env), now), 'ok', 'the 5th try may still be right');
  assert.equal(checkCode(null, 'x', now), 'none');
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(attemptsLeft), [4, 3, 2, 1, 0, 0]);
});

test('per-address limits: 60 s between codes, 5 an hour, 10 a day — the same for every address', () => {
  assert.equal(requestRefusal([], now), null);
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  assert.deepEqual(requestRefusal([ago(10)], now), { retryAfterSeconds: 50, reason: 'too_soon' });
  assert.equal(requestRefusal([ago(61)], now), null);
  assert.equal(requestRefusal([ago(61), ago(200), ago(300), ago(400)], now), null, '4 in the hour: one more allowed');
  const hour = requestRefusal([ago(61), ago(200), ago(300), ago(400), ago(500)], now);
  assert.equal(hour?.reason, 'hourly');
  assert.equal(hour?.retryAfterSeconds, 3600 - 500);
  const tenToday = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((h) => ago(h * 3600 + 10));
  assert.equal(requestRefusal(tenToday, now)?.reason, 'daily');
  assert.equal(requestRefusal(tenToday.slice(0, 9), now), null);
});

test('staff and deactivated accounts get no code; new and candidate addresses do', () => {
  assert.equal(sendRefusal(null, isStaffRole), null, 'a new address: the code is the sign-up');
  assert.equal(sendRefusal({ role: 'user' }, isStaffRole), null);
  assert.equal(sendRefusal({ role: 'admin' }, isStaffRole), 'staff');
  assert.equal(sendRefusal({ role: 'content_manager' }, isStaffRole), 'staff');
  assert.equal(sendRefusal({ role: 'user', deactivated: true }, isStaffRole), 'deactivated');
  // Several roles per account (23.11.2026): staff who are also a candidate / employer get a code (that session
  // carries only those roles); a staff-only account still gets none.
  assert.equal(sendRefusal({ role: 'content_manager', roles: ['content_manager', 'user'] }, isStaffRole), null);
  assert.equal(sendRefusal({ role: 'admin', roles: ['admin', 'employer'] }, isStaffRole), null);
  assert.equal(sendRefusal({ role: 'admin', roles: ['admin'] }, isStaffRole), 'staff');
});

test('the request answer is one fixed text, whatever the address', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'controllers', 'emailSigninController.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const requestCode'), src.indexOf('export const verifyCode'));
  // One success answer, sent before anything depends on the account (staff / deactivated / new / existing).
  assert.equal((body.match(/res\.json\(/g) ?? []).length, 1);
  assert.ok(body.indexOf('res.json(') < body.indexOf('if (noSend)'), 'the answer must leave before the account decides anything');
  assert.match(body, /NEUTRAL_REQUEST_ANSWER/);
  assert.ok(!/user\s*\?[^:]*res\.status/.test(body));
  assert.match(NEUTRAL_REQUEST_ANSWER, /^If this address/);
  // The verify step answers the same code (au12) for "no code", "wrong code" and staff.
  const verify = src.slice(src.indexOf('export const verifyCode'), src.indexOf('export const pendingSignup'));
  assert.ok((verify.match(/invalid\(/g) ?? []).length >= 4);
});

test('emails: valid shape only; normalised', () => {
  assert.equal(normalizeEmail('  A@B.CO '), 'a@b.co');
  assert.ok(isValidEmail('a@b.co'));
  for (const bad of ['', 'a', 'a@b', '@b.co', 'a b@c.co', 'x'.repeat(250) + '@b.co']) assert.equal(isValidEmail(normalizeEmail(bad)), false, bad);
});

test('the code email: Hebrew, the code and its lifetime, nothing else about the person', () => {
  const m = signInCodeEmail('042137', 'https://jobs.example');
  assert.match(m.subject, /042137/);
  assert.match(m.text, /042137/);
  assert.match(m.text, /10 דקות/);
  const html = rtlHtml(m.text);
  assert.match(html, /dir="rtl"/);
  assert.match(html, /lang="he"/);
  assert.ok(!rtlHtml('<script>x</script>').includes('<script>'), 'escaped');
});

// ---- Resend ----
const capture = async (fn: () => Promise<unknown>) => {
  const lines: string[] = [];
  const orig = { info: console.info, error: console.error, log: console.log, warn: console.warn };
  for (const k of ['info', 'error', 'log', 'warn'] as const) (console as any)[k] = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try { await fn().catch((e) => lines.push(`THROWN ${(e as Error).message}`)); } finally { Object.assign(console, orig); }
  return lines.join('\n');
};
const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<unknown>) => {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } }
};
const ON = { SEND_EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_test_key_123', EMAIL_FROM: 'SKEELZ <no-reply@mail.example>', NODE_ENV: 'production' };
const msg = { to: 'dana.cohen@example.com', subject: 'קוד הכניסה שלך: 987654', text: 'הקוד: 987654', kind: 'sign_in_code' };
const noPii = (out: string) => {
  assert.ok(!/dana|example\.com/i.test(out), `address in the log: ${out}`);
  assert.ok(!out.includes('987654'), `code in the log: ${out}`);
  assert.ok(!out.includes('re_test_key_123'), 'API key in the log');
};

test('Resend: one POST with the key, from, to, subject, text and RTL html; logs the id only', async () => {
  let call: any;
  _setFetchForTests((async (url: string, init: any) => { call = { url, init }; return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }); }) as any);
  const out = await capture(() => withEnv(ON, () => deliver(msg)));
  _setFetchForTests(null);
  assert.equal(call.url, RESEND_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer re_test_key_123');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.to, ['dana.cohen@example.com']);
  assert.equal(body.from, 'SKEELZ <no-reply@mail.example>');
  assert.equal(body.text, msg.text);
  assert.match(body.html, /dir="rtl"/);
  assert.deepEqual(body.tags, [{ name: 'kind', value: 'sign_in_code' }]);
  assert.ok(call.init.signal, 'a timeout signal');
  assert.match(out, /sent id=msg_1/);
  noPii(out);
});

test('Resend refusal / network error / timeout: an error code, never the response body', async () => {
  _setFetchForTests((async () => new Response(JSON.stringify({ message: 'Invalid `to` field: dana.cohen@example.com' }), { status: 422 })) as any);
  let err: unknown;
  const out1 = await capture(() => withEnv(ON, () => deliver(msg).catch((e) => { err = e; })));
  assert.ok(err instanceof EmailSendError && err.code === 'em4' && err.status === 422);
  assert.match(out1, /em4.*HTTP 422/);
  noPii(out1);
  _setFetchForTests((async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND api.resend.com dana.cohen@example.com'), { name: 'TimeoutError' }); }) as any);
  err = undefined;
  const out2 = await capture(() => withEnv(ON, () => deliver(msg).catch((e) => { err = e; })));
  assert.ok(err instanceof EmailSendError && err.code === 'em3');
  assert.match(out2, /em3.*timeout/);
  noPii(out2);
  // The old sendEmail() swallows it (a notice never breaks the action).
  const out3 = await capture(() => withEnv(ON, () => sendEmail(msg.to, msg.subject, msg.text)));
  noPii(out3);
  _setFetchForTests(null);
});

test('off (SEND_EMAIL_ENABLED not true): nothing leaves; no body or subject logged, not even in development; on without a key: em2', async () => {
  let called = false;
  _setFetchForTests((async () => { called = true; return new Response('{}'); }) as any);
  const prod = await capture(() => withEnv({ ...ON, SEND_EMAIL_ENABLED: 'false' }, () => deliver(msg)));
  assert.equal(called, false);
  noPii(prod);
  const dev = await capture(() => withEnv({ ...ON, SEND_EMAIL_ENABLED: undefined, NODE_ENV: 'development' }, () => deliver(msg)));
  assert.equal(called, false);
  noPii(dev);
  assert.doesNotMatch(dev, /987654/, 'in development too only the kind is printed (codes: /api/dev/email-code)');
  let err: unknown;
  const missing = await capture(() => withEnv({ ...ON, RESEND_API_KEY: undefined }, () => deliver(msg).catch((e) => { err = e; })));
  assert.ok(err instanceof EmailSendError && err.code === 'em2');
  assert.equal(called, false);
  noPii(missing);
  _setFetchForTests(null);
});

test('the code controller never prints an address or a code, and audits no code', () => {
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'controllers', 'emailSigninController.ts'), 'utf8');
  for (const line of src.split('\n').filter((l) => /console\.(log|info|warn|error)/.test(l))) {
    assert.ok(!/email|code\b|typed/.test(line.replace(/\[email-code\]/, '')), `console line may hold personal data: ${line.trim()}`);
  }
  for (const call of src.match(/writeAudit\([^;]*\);/gs) ?? []) {
    assert.ok(!/\b(code|typed|email)\s*[,}]/.test(call.replace(/typedEmailRef\(email[^)]*\)/g, 'REF')), `audit call may hold a code or address: ${call}`);
  }
});
