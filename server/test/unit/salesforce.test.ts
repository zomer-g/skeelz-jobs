// Salesforce: settings validation, what is written (mapping), retry rules, error codes. No network, no DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSalesforceSettings, salesforceBootMessage, normalizeApiVersion, SALESFORCE_ENV } from '../../src/config/salesforceSettings.js';
import {
  fieldsWritten, fitToDescribe, formatEmployerToSalesforceContact, formatEmployerToSalesforceAccount, employerAccountUpdateBody, formatGuestToSalesforceContact,
  formatJobToSalesforceJobApplicationsCase, formatJobToSalesforceJobCase, formatUserToSalesforceContact, jobCaseUpdateBody, sfDate,
  THRESHOLD_FIELDS, thresholdFieldsOf, usableOptionalField,
} from '../../src/utils/salesforceUtils.js';
import { betaMark } from '../../src/utils/salesforceUtils.js';
import { isPermanentError, nextRetryDelay, RETRY_DELAYS_S, syncRowState, isSyncKind, isApiKind } from '../../src/services/salesforceSyncPure.js';
import { isAuthErrorCode, salesforceErrorCode } from '../../src/internalApi/pure.js';

const SECRET = 'very-secret-value-0123456789';
const GOOD = {
  ENABLE_SALESFORCE: 'true',
  SALESFORCE_LOGIN_URL: 'https://skeelz.my.salesforce.com',
  SALESFORCE_CLIENT_ID: '3MVG9-consumer-key',
  SALESFORCE_CLIENT_SECRET: SECRET,
  SALESFORCE_CONTACTS_ACCOUNT_ID: '0018d00000AbCdEAAV',
  SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID: '0018d00000AbCdFAAV',
  SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID: '0128d000000AbCdAAA',
  SALESFORCE_CASE_ACCOUNT_ID: '0018d00000AbCdGAAV',
  SALESFORCE_CASE_RECORD_TYPE_ID: '0128d000000AbCeAAA',
};

test('settings: off unless ENABLE_SALESFORCE=true; on only when every setting is valid', () => {
  assert.equal(readSalesforceSettings({}).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, ENABLE_SALESFORCE: 'false' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, ENABLE_SALESFORCE: '1' }).enabled, false);
  const s = readSalesforceSettings(GOOD);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.problems, []);
  assert.equal(s.apiVersion, 'v62.0');
  assert.equal(s.loginUrl, 'https://skeelz.my.salesforce.com');
});

test('settings: a missing or invalid value keeps Salesforce OFF and names the variable, never a value', () => {
  const { SALESFORCE_CLIENT_SECRET: _s, ...noSecret } = GOOD;
  const s = readSalesforceSettings({ ...noSecret, SALESFORCE_CASE_RECORD_TYPE_ID: '0018d00000AbCdEAAV' });
  assert.equal(s.enabled, false);
  assert.equal(s.requested, true);
  assert.ok(s.problems.some((p) => p.startsWith('SALESFORCE_CLIENT_SECRET is missing')));
  assert.ok(s.problems.some((p) => p.startsWith('SALESFORCE_CASE_RECORD_TYPE_ID is not a Salesforce Record Type id')));
  const bad = readSalesforceSettings({ ...GOOD, SALESFORCE_CLIENT_ID: '', SALESFORCE_CONTACTS_ACCOUNT_ID: 'x' + SECRET });
  const text = [...bad.problems, salesforceBootMessage(bad).text].join('\n');
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(salesforceBootMessage(readSalesforceSettings(GOOD)).text, /secret-value|consumer-key|0018d/);
});

test('settings: the login URL must be My Domain (Client Credentials does not work on login.salesforce.com)', () => {
  for (const url of ['https://login.salesforce.com', 'https://test.salesforce.com', 'http://skeelz.my.salesforce.com',
    'https://skeelz.my.salesforce.com/path', 'https://evil.example/x.my.salesforce.com', 'http://127.0.0.1:3198']) {
    assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_LOGIN_URL: url }).enabled, false, url);
  }
  for (const url of ['https://skeelz.my.salesforce.com/', 'https://example-org.my.salesforce.com', 'https://skeelz--dev.sandbox.my.salesforce.com']) {
    assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_LOGIN_URL: url }).enabled, true, url);
  }
  // The local mock only with DEV_MODE=true.
  assert.equal(readSalesforceSettings({ ...GOOD, DEV_MODE: 'true', SALESFORCE_LOGIN_URL: 'http://127.0.0.1:3198' }).enabled, true);
});

test('settings: ids, version, employer Account, sandbox', () => {
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_CONTACTS_ACCOUNT_ID: '0018d00000AbCdE' }).enabled, true); // 15 chars
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_CONTACTS_ACCOUNT_ID: '0018d00000AbCdEAA' }).enabled, false); // 17
  assert.equal(normalizeApiVersion('65.0'), 'v65.0');
  assert.equal(normalizeApiVersion('v57.0'), 'v57.0');
  assert.equal(normalizeApiVersion('latest'), null);
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_API_VERSION: '65' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_API_VERSION: '65.0' }).apiVersion, 'v65.0');
  // Employers' companies: an Account each; its record type is optional and must be a record type id.
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID: '0018d00000ZZZZZAAV' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID: '0128d000000ZZZZAAA' }).employerAccountRecordTypeId, '0128d000000ZZZZAAA');
  const sb = readSalesforceSettings({ ...GOOD, SANDBOX: 'true' });
  assert.equal(sb.enabled, false);
  assert.equal(sb.complete, true); // the check may still run
  // Complete but switched off: the connection check may run before turning it on.
  assert.equal(readSalesforceSettings({ ...GOOD, ENABLE_SALESFORCE: 'false' }).complete, true);
  // The docs table and the code list the same names; only the secret is secret.
  assert.deepEqual(SALESFORCE_ENV.filter((v) => v.secret).map((v) => v.name), ['SALESFORCE_CLIENT_SECRET']);
});

test('mapping: a candidate without a birth date, city or skills still makes a valid Contact', () => {
  const c = formatUserToSalesforceContact({ _id: 'u1', firstName: 'Dana', lastName: '', email: 'd@x.test', phoneNumber: '050', dateOfBirth: null, gender: '', citySymbol: undefined, skills: undefined } as any);
  assert.equal(c.Birthdate, undefined);
  assert.equal(c.dateOfBirth_cambium__c, undefined);
  assert.equal(c.LastName, 'Dana'); // required on Contact
  assert.equal(c.ID_cambium__c, 'u1');
  assert.equal(c.skills_cambium__c, '');
  assert.equal(c.citySymbol_cambium__c, '');
  assert.equal(sfDate('2000-02-29T22:00:00.000Z'), '2000-02-29');
  assert.equal(sfDate('not a date'), undefined);
  const g = formatGuestToSalesforceContact({ _id: 'g1', fullName: '', email: 'g@x.test', phoneNumber: '1' });
  assert.equal(g.LastName, '-');
});

test('mapping: the application Case links its Contact, job and candidate; a job update keeps Account and record type', () => {
  const a = formatJobToSalesforceJobApplicationsCase({ _id: 'a1', jobId: 'j1', userId: 'u1' }, '003AAAAAAAAAAAAAAA');
  assert.equal(a.ContactId, '003AAAAAAAAAAAAAAA');
  assert.deepEqual([a.A_ID_cambium__c, a.A_PID_cambium__c, a.A_CID_cambium__c], ['a1', 'j1', 'u1']);
  assert.equal('ContactId' in formatJobToSalesforceJobApplicationsCase({ _id: 'a1', jobId: 'j1', userId: 'u1' }), false);
  const job = formatJobToSalesforceJobCase({ _id: 'j1', jobId: 7, title: 'T', jobScope: ['full'], requiredSkills: [], citySymbol: 5000, status: 'Active' } as any, null);
  assert.equal(job.PID_cambium__c, 'j1');
  assert.equal(job.PLocation_cambium__c, '');
  const upd = jobCaseUpdateBody(job);
  assert.equal('AccountId' in upd || 'RecordTypeId' in upd, false);
  assert.equal(upd.PID_cambium__c, 'j1');
  assert.equal('ContactId' in job, false);
});

test('mapping: jobs use the existing Position fields only (publish date, archive, external link, employer Contact)', () => {
  const base = { _id: 'j1', jobId: 7, title: 'T', jobScope: [], requiredSkills: ['s1', 's2'], citySymbol: 5000, status: 'Active',
    comments: 'פנימי', createdAt: '2026-11-01T08:00:00.000Z', publishDate: '2026-11-03T08:00:00.000Z' };
  const job = formatJobToSalesforceJobCase({ ...base, externalLink: 'https://jobs.example.test/apply' } as any, null, '003AAAAAAAAAAAAAAA');
  assert.equal(job.PCreatedDate_cambium__c, '2026-11-03T08:00:00.000Z'); // the publish date
  assert.equal(job.PStatus__c, 'Active');
  assert.equal(job.PSkills_cambium__c, 's1,s2');
  assert.equal(job.PComments_cambium__c, 'פנימי\nקישור חיצוני להגשה: https://jobs.example.test/apply');
  assert.equal(job.ContactId, '003AAAAAAAAAAAAAAA');
  assert.equal(jobCaseUpdateBody(job).ContactId, '003AAAAAAAAAAAAAAA');
  const archived = formatJobToSalesforceJobCase({ ...base, publishDate: undefined, deletedAt: new Date() } as any, null);
  assert.equal(archived.PStatus__c, 'Closed'); // removed from the board
  assert.equal(archived.PCreatedDate_cambium__c, '2026-11-01T08:00:00.000Z');
  assert.equal(archived.PComments_cambium__c, 'פנימי');
  // Only fields that existed before: nothing new on the job Case.
  const NEW = Object.keys(job).filter((k) => k.endsWith('__c') && !k.endsWith('_cambium__c') && k !== 'PStatus__c');
  assert.deepEqual(NEW, []);
});

test('mapping: an employer = a company Account and a Contact under it, both carrying the employer id', () => {
  const e = { id: 'e1', firstName: 'A', lastName: 'B', email: 'a@b.test', phone: '1', companyName: 'Co', jobTitle: 'HR' };
  const acc = formatEmployerToSalesforceAccount(e);
  assert.equal(acc.Name, 'Co');
  assert.equal(acc.SKEELZ_Employer_Id__c, 'e1');
  assert.equal('RecordTypeId' in employerAccountUpdateBody({ ...acc, RecordTypeId: '0128d000000ZZZZAAA' }), false);
  assert.equal(formatEmployerToSalesforceAccount({ ...e, companyName: ' ' }).Name, 'A B');
  const c = formatEmployerToSalesforceContact(e, '001AAAAAAAAAAAAAAA');
  assert.equal(c.AccountId, '001AAAAAAAAAAAAAAA');
  assert.equal(c.SKEELZ_Employer_Id__c, 'e1');
  assert.equal(c.Title, 'HR');
  assert.equal('Is_SKEELZ_Employer__c' in c, false);
  assert.match(c.Description, /^SKEELZ Jobs employer account e1$/);
  assert.equal(formatEmployerToSalesforceContact(e, undefined, { flagField: true }).Is_SKEELZ_Employer__c, true);
  assert.equal(isPermanentError('employer_id_field_missing'), true);
  assert.equal(salesforceErrorCode({ code: 'employer_id_field_missing' }), 'employer_id_field_missing');
});

test('mapping: the field list (for the connection check) comes from the formatters and holds the lookup fields', () => {
  const plan = fieldsWritten();
  const of = (kind: string) => plan.find((p) => p.kind === kind)!;
  for (const [kind, f] of [['candidate', 'ID_cambium__c'], ['job', 'PID_cambium__c'], ['application', 'A_ID_cambium__c'], ['guest', 'ID_cambium__c']]) {
    assert.ok(of(kind).fields.includes(f), `${kind} writes ${f}`);
    assert.equal(of(kind).lookupField, f);
  }
  assert.ok(of('application').fields.includes('ContactId'));
  assert.ok(of('candidate').fields.includes('Birthdate'));
  assert.ok(of('employer').fields.includes('AccountId'));
  assert.equal(of('employer').lookupField, 'SKEELZ_Employer_Id__c');
  assert.deepEqual(of('employer').optional, ['Is_SKEELZ_Employer__c']);
  assert.equal(of('employer_account').object, 'Account');
  assert.equal(of('employer_account').lookupField, 'SKEELZ_Employer_Id__c');
  assert.ok(of('job').fields.includes('ContactId'));
});

test('Beta: required as a writable checkbox, else nothing is sent (beta_field_missing, not retried by itself)', () => {
  const field = (o: object) => ({ name: 'Beta__c', type: 'boolean', length: 0, createable: true, updateable: true, filterable: true, ...o });
  const d = (f?: object) => ({ name: 'Contact', createable: true, updateable: true, fields: f ? [field(f)] : [] });
  assert.deepEqual(betaMark(d({}), 'Beta__c'), { Beta__c: true });
  for (const bad of [d(), d({ type: 'string' }), d({ createable: false }), d({ updateable: false }), null]) {
    assert.throws(() => betaMark(bad as any, 'Beta__c'), (e: any) => e.code === 'beta_field_missing');
  }
  assert.equal(isPermanentError('beta_field_missing'), true);
  assert.equal(salesforceErrorCode({ code: 'beta_field_missing' }), 'beta_field_missing');
  assert.equal(readSalesforceSettings(GOOD).betaField, 'Beta__c');
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_BETA_FIELD: 'Is_Beta__c' }).betaField, 'Is_Beta__c');
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_BETA_FIELD: 'Beta' }).enabled, false);
});

test('fitToDescribe cuts text to the field length and leaves the rest', () => {
  const d = { name: 'Contact', createable: true, updateable: true, fields: [
    { name: 'LastName', type: 'string', length: 5, createable: true, updateable: true, filterable: true }] };
  assert.deepEqual(fitToDescribe({ LastName: 'abcdefgh', Other: 'xyz', n: 3 }, d), { LastName: 'abcde', Other: 'xyz', n: 3 });
  assert.deepEqual(fitToDescribe({ LastName: 'abcdefgh' }, null), { LastName: 'abcdefgh' });
});

test('retries: growing waits, a cap, and no retry for permanent failures', () => {
  assert.equal(nextRetryDelay('http_503', 1), 60);
  assert.equal(nextRetryDelay('net_ECONNRESET', 2), 300);
  assert.equal(nextRetryDelay('http_503', RETRY_DELAYS_S.length), 24 * 3600);
  assert.equal(nextRetryDelay('http_503', RETRY_DELAYS_S.length + 1), null);
  assert.equal(nextRetryDelay('auth_invalid_client', 1), 60);
  for (const code of ['http_400_REQUIRED_FIELD_MISSING', 'http_400', 'not_found', 'imported_read_only', 'candidate_http_400_INVALID_FIELD']) {
    assert.equal(isPermanentError(code), true, code);
    assert.equal(nextRetryDelay(code, 1), null, code);
  }
  assert.equal(isPermanentError('http_404'), false);
  assert.equal(syncRowState({ queued_at: 'x', last_error_code: null, last_pushed_at: null }), 'queued');
  assert.equal(syncRowState({ queued_at: 'x', last_error_code: 'http_503', last_pushed_at: null }), 'retrying');
  assert.equal(syncRowState({ queued_at: null, last_error_code: 'http_400', last_pushed_at: null }), 'failed');
  assert.equal(syncRowState({ queued_at: null, last_error_code: null, last_pushed_at: 'x' }), 'synced');
  assert.equal(isSyncKind('guest_application'), true);
  assert.equal(isApiKind('guest_application'), false); // the internal API pushes job / application / candidate only
});

test('error codes: the OAuth error code from sign-in, never a body', () => {
  const authErr = Object.assign(new Error('Salesforce authentication failed (invalid_client)'), { name: 'SalesforceAuthError', code: 'invalid_client' });
  assert.equal(salesforceErrorCode(authErr), 'auth_invalid_client');
  assert.equal(salesforceErrorCode(Object.assign(new Error('x'), { name: 'SalesforceAuthError', code: 'Bad <b>' })), 'auth');
  assert.equal(salesforceErrorCode(Object.assign(new Error('x'), { name: 'SalesforceAuthError', code: 'net_ECONNREFUSED' })), 'auth_net_ECONNREFUSED');
  assert.equal(salesforceErrorCode({ code: 'imported_read_only' }), 'imported_read_only');
  assert.equal(salesforceErrorCode({ response: { status: 400, data: [{ errorCode: 'DUPLICATES_DETECTED', message: 'a@b.co' }] } }), 'http_400_DUPLICATES_DETECTED');
  assert.equal(isAuthErrorCode('auth'), true);
  assert.equal(isAuthErrorCode('auth_invalid_client'), true);
  assert.equal(isAuthErrorCode('http_401'), false);
  assert.equal(isAuthErrorCode(undefined), false);
});

test('threshold condition: job Case text (null clears it), application confirmation + time, each only when the org has the field', () => {
  const field = (name: string, type: string, o: object = {}) => ({ name, type, length: 1000, createable: true, updateable: true, filterable: false, ...o });
  const all = { name: 'Case', createable: true, updateable: true, fields: [
    field('Threshold_Condition__c', 'textarea'), field('Threshold_Confirmed__c', 'boolean'), field('Threshold_Confirmed_At__c', 'datetime')] };
  assert.deepEqual(thresholdFieldsOf(all), { condition: true, confirmed: true, confirmedAt: true });
  assert.deepEqual(thresholdFieldsOf(null), { condition: false, confirmed: false, confirmedAt: false });
  // Wrong type or no edit permission → not used.
  assert.equal(usableOptionalField({ ...all, fields: [field('Threshold_Confirmed__c', 'string')] }, 'Threshold_Confirmed__c'), false);
  assert.equal(usableOptionalField({ ...all, fields: [field('Threshold_Condition__c', 'textarea', { updateable: false })] }, 'Threshold_Condition__c'), false);
  assert.equal(usableOptionalField({ ...all, fields: [field('Threshold_Condition__c', 'string')] }, 'Threshold_Condition__c'), true);

  const job = { _id: 'j1', jobId: 7, title: 't', status: 'Active', thresholdCondition: '  <b>שנתיים</b> ניסיון ' } as any;
  const inOrg = thresholdFieldsOf(all);
  assert.equal(formatJobToSalesforceJobCase(job, null, undefined, inOrg).Threshold_Condition__c, 'שנתיים ניסיון');
  // No condition → null (clears the field on an update), and the update body keeps it.
  const none = formatJobToSalesforceJobCase({ ...job, thresholdCondition: null }, null, undefined, inOrg);
  assert.equal(none.Threshold_Condition__c, null);
  assert.equal(jobCaseUpdateBody(none).Threshold_Condition__c, null);
  // Field not in the org → not sent at all (the rest of the Case still goes).
  assert.equal('Threshold_Condition__c' in formatJobToSalesforceJobCase(job, null), false);
  assert.equal('Threshold_Condition__c' in formatJobToSalesforceJobCase(job, null, undefined, { ...inOrg, condition: false }), false);

  const at = new Date('2026-11-17T10:00:00.000Z');
  const app = { _id: 'a1', jobId: 'j1', userId: 'u1', thresholdConfirmed: true, thresholdConfirmedAt: at };
  const c = formatJobToSalesforceJobApplicationsCase(app, '003x', inOrg);
  assert.deepEqual([c.Threshold_Confirmed__c, c.Threshold_Confirmed_At__c], [true, '2026-11-17T10:00:00.000Z']);
  assert.equal('Threshold_Condition__c' in c, false, 'the text is not stored with the application');
  const plain = formatJobToSalesforceJobApplicationsCase({ _id: 'a2', jobId: 'j2', userId: 'u1' }, '003x', inOrg);
  assert.equal(plain.Threshold_Confirmed__c, false);
  assert.equal('Threshold_Confirmed_At__c' in plain, false);
  assert.equal('Threshold_Confirmed__c' in formatJobToSalesforceJobApplicationsCase(app, '003x'), false);
  assert.equal('Threshold_Confirmed_At__c' in formatJobToSalesforceJobApplicationsCase(app, '003x', { ...inOrg, confirmedAt: false }), false);

  // The check's plan lists the three as optional Case fields (missing → named and skipped, never a failure).
  const th = fieldsWritten().find((p) => p.kind === 'threshold')!;
  assert.deepEqual([th.object, th.optional, th.fields], ['Case', Object.values(THRESHOLD_FIELDS), []]);
});
