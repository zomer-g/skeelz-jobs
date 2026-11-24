// Added fields (settings screen, owner 23.11.2026): definitions, answers, required, clearing, what staff and the job
// page see, and that Salesforce never receives them. No DB. Run: npx tsc && npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  checkDefinition, checkCustomValues, mergeCustomValues, missingRequired, shownValues, formFields, changedKeys, asCustomValues,
  CUSTOM_FIELD_LIMITS,
} = await import('../dist/models/schemas/customFields.js');

const def = (over) => ({ id: 'f1', form: 'signup', label: 'שאלה', type: 'text', options: [], required: false, sortOrder: 10,
  active: true, showOnJobPage: false, help: '', sfField: null, ...over });

test('a new definition: label, type and options are checked; unknown keys refused', () => {
  assert.deepEqual(checkDefinition({ label: '  רישיון  נהיגה ', type: 'checkbox' }),
    { ok: true, value: { label: 'רישיון נהיגה', type: 'checkbox', options: [], required: false, sortOrder: 0, active: true, showOnJobPage: false, help: '', sfField: null } });
  assert.equal(checkDefinition({ type: 'text' }).error, 'bad_label');
  assert.equal(checkDefinition({ label: 'א', type: 'text' }).error, 'bad_label');
  assert.equal(checkDefinition({ label: 'x'.repeat(CUSTOM_FIELD_LIMITS.label.max + 1), type: 'text' }).error, 'bad_label');
  assert.equal(checkDefinition({ label: 'שאלה' }).error, 'bad_type');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'date' }).error, 'bad_type');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'select', options: ['אחת'] }).error, 'bad_options');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'select', options: ['א', 'א'] }).error, 'bad_options');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'text', options: ['א', 'ב'] }).error, 'bad_options');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'text', required: 'yes' }).error, 'bad_value');
  assert.equal(checkDefinition({ label: 'שאלה', type: 'text', value: 1 }).error, 'unknown_key');
  assert.equal(checkDefinition({ label: '<b>שאלה</b>', type: 'text' }).value.label, 'שאלה');
  assert.deepEqual(checkDefinition({ label: 'משמרות', type: 'select', options: ['בוקר', ' ערב '] }).value.options, ['בוקר', 'ערב']);
});

test('a change keeps what was not sent, and the type never changes', () => {
  const { id, form, ...base } = def({ type: 'select', options: ['א', 'ב'] });
  const r = checkDefinition({ active: false }, base);
  assert.equal(r.ok, true);
  assert.equal(r.value.active, false);
  assert.deepEqual(r.value.options, ['א', 'ב']);
  assert.equal(checkDefinition({ type: 'text' }, base).error, 'type_fixed');
  assert.deepEqual(changedKeys(base, r.value), ['active']);
});

test('answers: only active fields, unknown keys dropped, select from its options, required enforced', () => {
  const defs = [
    def({ id: 'a', required: true }),
    def({ id: 'b', type: 'select', options: ['בוקר', 'ערב'] }),
    def({ id: 'c', type: 'checkbox', required: true }),
    def({ id: 'd', active: false }),
  ];
  assert.deepEqual(checkCustomValues(defs, { a: ' שלום ', b: 'ערב', c: true, d: 'x', evil: 'y' }, { requireAll: true }),
    { ok: true, values: { a: 'שלום', b: 'ערב', c: true } });
  assert.deepEqual(checkCustomValues(defs, {}, { requireAll: true }), { ok: false, bad: ['a', 'c'] });
  assert.deepEqual(checkCustomValues(defs, { a: 'x', c: false }, { requireAll: true }), { ok: false, bad: ['c'] }, 'a required checkbox must be ticked');
  assert.deepEqual(checkCustomValues(defs, { a: 'x', c: true, b: 'לילה' }), { ok: false, bad: ['b'] });
  assert.deepEqual(checkCustomValues(defs, { a: 7, c: true }), { ok: false, bad: ['a'] });
  assert.deepEqual(checkCustomValues(defs, { a: 'x'.repeat(CUSTOM_FIELD_LIMITS.text.max + 1) }), { ok: false, bad: ['a'] });
  assert.deepEqual(checkCustomValues(defs, { a: '<script>  </script>' }), { ok: false, bad: ['a'] }, 'only tags = empty, and a is required');
  // Without requireAll (the personal area, a job edit): only what was sent; '' clears an optional one, never a required one.
  assert.deepEqual(checkCustomValues(defs, { b: '' }), { ok: true, values: { b: null } });
  assert.deepEqual(checkCustomValues(defs, { a: '' }), { ok: false, bad: ['a'] });
  assert.deepEqual(checkCustomValues(defs, 'nonsense'), { ok: true, values: {} });
  assert.deepEqual(checkCustomValues(defs, ['a']), { ok: true, values: {} });
});

test('stored answers: merge, clear, and what is missing', () => {
  const defs = [def({ id: 'a', required: true }), def({ id: 'b' })];
  assert.deepEqual(mergeCustomValues({ a: 'x', b: 'y' }, { b: null, c: true }), { a: 'x', c: true });
  assert.deepEqual(asCustomValues({ a: 'x', b: 3, c: { d: 1 }, e: false }), { a: 'x', e: false });
  assert.deepEqual(missingRequired(defs, {}), ['a']);
  assert.deepEqual(missingRequired(defs, { a: 'x' }), []);
  assert.deepEqual(missingRequired([def({ id: 'a', required: true, active: false })], {}), [], 'a field turned off asks nothing');
});

test('what staff see (labels, off fields too) and what the job page shows (job fields marked so, active)', () => {
  const defs = [
    def({ id: 'a', label: 'שנייה', sortOrder: 20 }),
    def({ id: 'b', label: 'ראשונה', sortOrder: 10, type: 'checkbox' }),
    def({ id: 'c', label: 'כבויה', active: false, sortOrder: 30 }),
  ];
  assert.deepEqual(shownValues(defs, { a: 'x', b: true, c: 'y', z: 'q' }).map((v) => [v.label, v.value, v.active]),
    [['ראשונה', 'כן', true], ['שנייה', 'x', true], ['כבויה', 'y', false]]);
  const jobDefs = [def({ id: 'j1', form: 'job', label: 'שכר', showOnJobPage: true }), def({ id: 'j2', form: 'job', label: 'פנימי' }),
    def({ id: 'j3', form: 'job', label: 'כבוי', showOnJobPage: true, active: false })];
  assert.deepEqual(shownValues(jobDefs, { j1: '40 ₪', j2: 'x', j3: 'y' }, { onlyJobPage: true }).map((v) => v.label), ['שכר']);
  // A sign-up field is never shown on a public page, even if marked.
  assert.deepEqual(shownValues([def({ id: 's', showOnJobPage: true })], { s: 'x' }, { onlyJobPage: true }), []);
});

test('the public sign-up form gets active definitions only, without staff flags', () => {
  const out = formFields([def({ id: 'a', sortOrder: 20 }), def({ id: 'b', sortOrder: 10, active: false }), def({ id: 'c', sortOrder: 5 })]);
  assert.deepEqual(out.map((f) => f.id), ['c', 'a']);
  assert.deepEqual(Object.keys(out[0]).sort(), ['help', 'id', 'label', 'options', 'required', 'type']);
});

test('Salesforce never receives the added fields (Contact and Position mapping)', async () => {
  const sf = await import('../dist/utils/salesforceUtils.js');
  const user = { _id: 'u1', firstName: 'א', lastName: 'ב', email: 'a@example.test', phoneNumber: '0501234567', customFields: { a: 'secret-answer' } };
  const contact = sf.formatUserToSalesforceContact(user);
  assert.ok(!JSON.stringify(contact).includes('secret-answer'));
});

test('employer form errors and edit requests: error codes by field, only changed answers', async () => {
  const { errorCodesOf, changedValues } = await import('../dist/models/schemas/customFields.js');
  const defs = [def({ id: 'a', required: true }), def({ id: 'b', type: 'select', options: ['x', 'y'] })];
  assert.deepEqual(errorCodesOf(defs, { b: 'z' }, ['a', 'b']), { 'customFields.a': 'required', 'customFields.b': 'invalid' });
  assert.deepEqual(changedValues({ a: 'same', b: 'x' }, { a: 'same', b: 'y', c: null }), { b: 'y' });
  assert.deepEqual(changedValues({ a: 'v', k: true }, { a: null, k: false }), { a: null, k: null });
});

test('Salesforce: an added field is sent only when linked AND the org has it, writable, of a fitting type; active only', async () => {
  const { customFieldLinkStatus, customFieldsForSalesforce } = await import('../dist/utils/salesforceUtils.js');
  const { SF_FIELD_RE } = await import('../dist/models/schemas/customFields.js');
  const d = { name: 'Contact', createable: true, updateable: true, fields: [
    { name: 'Shift__c', type: 'picklist', length: 255, createable: true, updateable: true, filterable: true },
    { name: 'Notes__c', type: 'textarea', length: 50, createable: true, updateable: true, filterable: false },
    { name: 'Car__c', type: 'boolean', length: 0, createable: true, updateable: true, filterable: true },
    { name: 'Locked__c', type: 'string', length: 255, createable: true, updateable: false, filterable: true },
  ] };
  const defs = [
    def({ id: 's', type: 'select', options: ['בוקר', 'ערב'], sfField: 'Shift__c' }),
    def({ id: 'n', sfField: 'Notes__c' }),
    def({ id: 'c', type: 'checkbox', sfField: 'Car__c' }),
    def({ id: 'u', sfField: null }),
    def({ id: 'm', sfField: 'Missing__c' }),
    def({ id: 'w', type: 'checkbox', sfField: 'Notes__c' }),
    def({ id: 'l', sfField: 'Locked__c' }),
    def({ id: 'off', type: 'checkbox', sfField: 'Car__c', active: false }),
  ];
  assert.deepEqual(defs.map((x) => customFieldLinkStatus(x, d)), ['ok', 'ok', 'ok', 'not_linked', 'missing', 'wrong_type', 'not_writable', 'ok']);
  assert.equal(customFieldLinkStatus(defs[0], null), 'missing', 'no describe → never sent');
  assert.deepEqual(customFieldsForSalesforce(defs, { s: 'ערב', n: 'טקסט', u: 'x', m: 'y', w: true, l: 'z', off: true }, d),
    { Shift__c: 'ערב', Notes__c: 'טקסט', Car__c: false });
  assert.deepEqual(customFieldsForSalesforce(defs, {}, d), { Shift__c: null, Notes__c: null, Car__c: false }, 'unanswered → cleared there');
  assert.deepEqual(customFieldsForSalesforce(defs, { s: 'ערב' }, null), {});
  for (const ok of ['Shift__c', 'A_b_9__c']) assert.ok(SF_FIELD_RE.test(ok), ok);
  for (const bad of ['Email', 'Shift', '__c', '9x__c', 'Bad-name__c', 'x'.repeat(40) + '__c', "a__c'; DROP"]) assert.ok(!SF_FIELD_RE.test(bad), bad);
});
