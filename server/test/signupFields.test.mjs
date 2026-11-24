// Sign-up fields setting (required / optional / hidden) and the Israeli ID number (תעודת זהות): check digit,
// server-side enforcement, clearing, redaction. No DB. Run: npx tsc && npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  checkProfile, profileIncomplete, normalizeIsraeliId, normalizeSignupFields, isSignupFieldMode, requiredProfileFields,
  DEFAULT_SIGNUP_FIELDS, redactText,
} = await import('../dist/security/pure.js');
const { formatUserToSalesforceContact, ID_NUMBER_FIELD, contactFieldsOf, fieldsWritten } = await import('../dist/utils/salesforceUtils.js');
const now = new Date('2026-11-19T10:00:00Z');
const full = {
  firstName: 'דנה', lastName: 'כהן', phoneNumber: '0521234567', citySymbol: 3000, gender: 'female',
  dateOfBirth: '1990-05-01T00:00:00.000Z', skills: [],
};

test('ID number: check digit, padding, refusals', () => {
  assert.equal(normalizeIsraeliId('000000018'), '000000018');
  assert.equal(normalizeIsraeliId('18'), null); // too short
  assert.equal(normalizeIsraeliId('123456782'), '123456782');
  assert.equal(normalizeIsraeliId(' 123456782 '), '123456782');
  assert.equal(normalizeIsraeliId('12345678'), null); // pads to 012345678: wrong check digit
  assert.equal(normalizeIsraeliId('123456789'), null); // wrong check digit
  assert.equal(normalizeIsraeliId('000000000'), null);
  assert.equal(normalizeIsraeliId('12345678a'), null);
  assert.equal(normalizeIsraeliId('1234567820'), null); // 10 digits
  assert.equal(normalizeIsraeliId(null), null);
});

test('default setting = the form as before, ID number optional', () => {
  assert.deepEqual({ ...DEFAULT_SIGNUP_FIELDS }, { phoneNumber: 'required', citySymbol: 'required', gender: 'required', dateOfBirth: 'required', idNumber: 'optional' });
  assert.deepEqual(requiredProfileFields(), ['firstName', 'lastName', 'phoneNumber', 'citySymbol', 'gender', 'dateOfBirth']);
  assert.equal(checkProfile(full, { requireAll: true, now }).ok, true);
});

test('the setting is enforced by the server: required ID refused when missing, bad ID refused, good ID normalized', () => {
  const fields = normalizeSignupFields({ idNumber: 'required' });
  assert.deepEqual(checkProfile(full, { requireAll: true, now, fields }), { ok: false, bad: ['idNumber'] });
  assert.deepEqual(checkProfile({ ...full, idNumber: '123456789' }, { requireAll: true, now, fields }), { ok: false, bad: ['idNumber'] });
  const r = checkProfile({ ...full, idNumber: '23' + '' }, { requireAll: true, now, fields });
  assert.equal(r.ok, false);
  const ok = checkProfile({ ...full, idNumber: '123456782' }, { requireAll: true, now, fields });
  assert.equal(ok.ok, true);
  assert.equal(ok.values.idNumber, '123456782');
});

test('optional fields may be left out; a hidden ID number is dropped', () => {
  const fields = normalizeSignupFields({ dateOfBirth: 'optional', gender: 'optional', phoneNumber: 'optional', citySymbol: 'optional', idNumber: 'hidden' });
  const r = checkProfile({ firstName: 'דנה', lastName: 'כהן', idNumber: '123456782' }, { requireAll: true, now, fields });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.values).sort(), ['firstName', 'lastName']);
  // A given optional value is still checked.
  assert.deepEqual(checkProfile({ firstName: 'דנה', lastName: 'כהן', dateOfBirth: '2999-01-01' }, { requireAll: true, now, fields }), { ok: false, bad: ['dateOfBirth'] });
  // Names stay required whatever the setting.
  assert.deepEqual(checkProfile({ firstName: 'דנה' }, { requireAll: true, now, fields }), { ok: false, bad: ['lastName'] });
});

test('personal area: an empty ID number clears it unless required', () => {
  assert.deepEqual(checkProfile({ idNumber: '' }, { now, allowClear: true }), { ok: true, values: { idNumber: null } });
  assert.deepEqual(checkProfile({ idNumber: '' }, { now }), { ok: true, values: {} });
  assert.deepEqual(checkProfile({ idNumber: '' }, { now, allowClear: true, fields: normalizeSignupFields({ idNumber: 'required' }) }), { ok: true, values: {} });
});

test('setting values: only known fields and modes; hidden only for the ID number', () => {
  assert.equal(isSignupFieldMode('idNumber', 'hidden'), true);
  assert.equal(isSignupFieldMode('dateOfBirth', 'hidden'), false);
  assert.equal(isSignupFieldMode('firstName', 'optional'), false);
  assert.equal(isSignupFieldMode('email', 'optional'), false);
  assert.equal(isSignupFieldMode('gender', 'yes'), false);
  assert.deepEqual(normalizeSignupFields({ gender: 'optional', firstName: 'optional', dateOfBirth: 'hidden' }),
    { ...DEFAULT_SIGNUP_FIELDS, gender: 'optional' });
  assert.deepEqual(normalizeSignupFields(null), { ...DEFAULT_SIGNUP_FIELDS });
});

test('profileIncomplete follows the setting for phone and town', () => {
  const u = { role: 'user', phoneNumber: null, citySymbol: 0 };
  assert.equal(profileIncomplete(u), true);
  assert.equal(profileIncomplete(u, normalizeSignupFields({ phoneNumber: 'optional', citySymbol: 'optional' })), false);
});

test('ID numbers are masked in console text; ObjectIds and short numbers are not', () => {
  assert.equal(redactText('id 123456782 refused'), 'id [id] refused');
  assert.equal(redactText('user 0123456789abcdef01234567 ok, 3 rows, job 1902'), 'user 0123456789abcdef01234567 ok, 3 rows, job 1902');
});

test('Salesforce: the ID number only when the org has the field', () => {
  const user = { _id: 'x', firstName: 'a', lastName: 'b', email: '', phoneNumber: '', dateOfBirth: '2000-01-01', gender: '', citySymbol: 1, skills: [], cvFileUrl: '', idNumber: '123456782' };
  assert.equal(ID_NUMBER_FIELD in formatUserToSalesforceContact(user), false);
  assert.equal(ID_NUMBER_FIELD in formatUserToSalesforceContact(user, contactFieldsOf(null)), false);
  const d = { name: 'Contact', createable: true, updateable: true, fields: [{ name: ID_NUMBER_FIELD, type: 'string', length: 9, createable: true, updateable: true, filterable: true }] };
  assert.equal(formatUserToSalesforceContact(user, contactFieldsOf(d))[ID_NUMBER_FIELD], '123456782');
  assert.equal(formatUserToSalesforceContact({ ...user, idNumber: null }, contactFieldsOf(d))[ID_NUMBER_FIELD], null);
  const wrongType = { ...d, fields: [{ ...d.fields[0], type: 'double' }] };
  assert.equal(contactFieldsOf(wrongType).idNumber, false);
  // The candidate Contact's required fields don't include it (an org without it still syncs).
  const c = fieldsWritten().find((p) => p.kind === 'candidate');
  assert.equal(c.fields.includes(ID_NUMBER_FIELD), false);
  assert.deepEqual(fieldsWritten().find((p) => p.kind === 'id_number').optional, [ID_NUMBER_FIELD]);
});
