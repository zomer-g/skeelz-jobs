// A candidate's own details (SSO sign-up form, "complete your details", personal area): the field allowlist and
// the same rules as the sign-up form. No DB. Run: npx tsc && npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkProfile, profileIncomplete, phoneOk, PROFILE_FIELDS } = await import('../dist/security/pure.js');
const now = new Date('2026-11-12T10:00:00Z');
const full = {
  firstName: 'דנה', lastName: 'כהן', phoneNumber: '0521234567', citySymbol: 3000, gender: 'female',
  dateOfBirth: '1990-05-01T00:00:00.000Z', skills: ['0123456789abcdef01234567'],
};

test('a full sign-up passes; only allowlisted fields come out', () => {
  const r = checkProfile({ ...full, email: 'other@example.test', role: 'admin', password: 'x', _id: 'someone', xhostd_sub: 's' }, { requireAll: true, now });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.values).sort(), Object.keys(full).sort());
  for (const k of Object.keys(r.values)) assert.ok(PROFILE_FIELDS.includes(k));
});

test('requireAll names every missing required field', () => {
  const r = checkProfile({ firstName: 'דנה' }, { requireAll: true, now });
  assert.equal(r.ok, false);
  assert.deepEqual(r.bad.sort(), ['citySymbol', 'dateOfBirth', 'gender', 'lastName', 'phoneNumber']);
});

test('a partial edit checks only what is given; empty values are ignored (never clear a field)', () => {
  assert.deepEqual(checkProfile({ phoneNumber: '0521234567' }, { now }), { ok: true, values: { phoneNumber: '0521234567' } });
  assert.deepEqual(checkProfile({ phoneNumber: '', citySymbol: null }, { now }), { ok: true, values: {} });
});

test('the sign-up form rules', () => {
  const bad = (patch) => checkProfile({ ...full, ...patch }, { requireAll: true, now });
  assert.deepEqual(bad({ firstName: 'א' }).bad, ['firstName']);
  assert.deepEqual(bad({ lastName: 'Cohen2' }).bad, ['lastName']);
  assert.deepEqual(bad({ phoneNumber: '12345' }).bad, ['phoneNumber']);
  assert.deepEqual(bad({ citySymbol: -1 }).bad, ['citySymbol']);
  assert.deepEqual(bad({ gender: 'x' }).bad, ['gender']);
  assert.deepEqual(bad({ dateOfBirth: '2030-01-01' }).bad, ['dateOfBirth']);
  assert.deepEqual(bad({ dateOfBirth: '1800-01-01' }).bad, ['dateOfBirth']);
  assert.deepEqual(bad({ skills: ['not-an-id'] }).bad, ['skills']);
  assert.ok(phoneOk('0521234567') && phoneOk('021234567') && !phoneOk('05212345') && !phoneOk('052-1234567'));
});

test('profileIncomplete: candidates without a phone or a town; never staff', () => {
  assert.equal(profileIncomplete({ role: 'user', phoneNumber: null, citySymbol: -1 }), true);
  assert.equal(profileIncomplete({ role: 'user', phoneNumber: '0521234567', citySymbol: -1 }), true);
  assert.equal(profileIncomplete({ role: 'user', phoneNumber: '0521234567', citySymbol: 3000 }), false);
  assert.equal(profileIncomplete({ role: 'admin', phoneNumber: null, citySymbol: -1 }), false);
});
