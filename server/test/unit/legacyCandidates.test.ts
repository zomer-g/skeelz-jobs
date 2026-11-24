// The existing site's candidates (owner, 20.11.2026): a Contact → the read-only copy here (legacyCandidatesPure), the
// newest CV pointer, the full update after the cutover and the settings. No network, no DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CandidateContext, changedCandidateColumns, contactToCandidate, fillEmptyColumns, fullContactPatch, isSfCvKey, newestCvs,
  normalizeBirthDate, normalizePhone, sfCvFileName, sfCvKey,
} from '../../src/services/legacyCandidatesPure.js';
import { readSalesforceSettings } from '../../src/config/salesforceSettings.js';

const CANDIDATES = '001Tw00000M80rFIAR';
const RETRAIN = '0018d00000WS5TrAAL';
const SKILL_A = '677e68ea063529e50d3e9822';
const SKILL_B = '677e68ea063529e50d3e9826';
const ctx = (over: Partial<CandidateContext> = {}): CandidateContext => ({
  quickAccounts: new Set([CANDIDATES]),
  skillIds: new Set([SKILL_A, SKILL_B]),
  citySymbols: new Set([8600, 4000]),
  cityByName: new Map([['רמת גן', 8600], ['חיפה', 4000]]),
  now: new Date('2026-11-20T10:00:00Z'),
  ...over,
});
const REGISTERED = {
  Id: '003Sr00000kR2HlIAK', AccountId: CANDIDATES, ID_cambium__c: '6a1f0c2e9b1d4e0012345678', LastModifiedDate: '2026-11-19T08:00:00.000+0000',
  firstName_cambium__c: 'דנה', lastName_cambium__c: 'לוי', email_cambium__c: 'Dana@Example.test', phoneNumber_cambium__c: '050-123-4567',
  dateOfBirth_cambium__c: '1990-05-01', gender_cambium__c: 'female', citySymbol_cambium__c: '8600',
  skills_cambium__c: `${SKILL_A},${SKILL_B},677e68ea063529e50d3e9999`,
};

test('a registered candidate of the existing site becomes a copy with this site\'s formats', () => {
  const r = contactToCandidate(REGISTERED, ctx());
  assert.ok(r.ok);
  const c = r.candidate;
  assert.equal(c.email, 'dana@example.test');
  assert.equal(c.phoneNumber, '0501234567');
  assert.equal(c.dateOfBirth?.toISOString(), '1990-05-01T00:00:00.000Z');
  assert.equal(c.gender, 'female');
  assert.equal(c.citySymbol, 8600);
  assert.deepEqual(c.skills, [SKILL_A, SKILL_B], 'unknown skill ids dropped');
  assert.equal(c.cid, '6a1f0c2e9b1d4e0012345678');
});

test('quick applicants (no date of birth, no gender, in the candidates\' Account) are not copied', () => {
  const quick = { ...REGISTERED, dateOfBirth_cambium__c: null, gender_cambium__c: null };
  assert.deepEqual(contactToCandidate(quick, ctx()), { ok: false, code: 'quick_application' });
  // The Retrain candidates (name, email, phone only) are copied.
  const retrain = { Id: '003Sr00000aaaaaAAA', AccountId: RETRAIN, ID_cambium__c: 'r-1', FirstName: 'Noa', LastName: 'Cohen', Email: 'noa@example.test', MobilePhone: '+972 52-765-4321', MailingCity: 'חיפה' };
  const r = contactToCandidate(retrain, ctx());
  assert.ok(r.ok);
  assert.equal(r.candidate.firstName, 'Noa');
  assert.equal(r.candidate.phoneNumber, '0527654321');
  assert.equal(r.candidate.citySymbol, 4000, 'city by name');
  assert.equal(r.candidate.dateOfBirth, null);
});

test('no email or no name: skipped with a code', () => {
  assert.deepEqual(contactToCandidate({ ...REGISTERED, email_cambium__c: 'not-an-email', Email: '' }, ctx()), { ok: false, code: 'no_email' });
  assert.deepEqual(contactToCandidate({ ...REGISTERED, firstName_cambium__c: '', lastName_cambium__c: '' }, ctx()), { ok: false, code: 'no_name' });
});

test('values outside this site\'s rules are left empty, not invented', () => {
  const r = contactToCandidate({ ...REGISTERED, gender_cambium__c: 'שם של מישהו', citySymbol_cambium__c: '0', phoneNumber_cambium__c: '12', dateOfBirth_cambium__c: '2020-01-01' }, ctx());
  assert.ok(r.ok);
  assert.equal(r.candidate.gender, '');
  assert.equal(r.candidate.citySymbol, 0);
  assert.equal(r.candidate.phoneNumber, null);
  assert.equal(r.candidate.dateOfBirth, null, 'younger than 14');
  assert.equal(normalizePhone('03-1234567'), '031234567');
  assert.equal(normalizeBirthDate('1890-01-01', new Date('2026-01-01')), null);
});

test('the newest pdf/doc/docx on each Contact is its CV; the pointer and file name', () => {
  const link = (who: string, id: string, ext: string, at: string, title = 'CV') =>
    ({ LinkedEntityId: who, ContentDocument: { Title: title, FileExtension: ext, LatestPublishedVersionId: id, ContentModifiedDate: at } });
  const cvs = newestCvs([
    link('A', '068Sr000001aaaaIAA', 'pdf', '2025-01-01'),
    link('A', '068Sr000001bbbbIAA', 'docx', '2026-01-01', 'קורות חיים/2026'),
    link('A', '068Sr000001ccccIAA', 'png', '2027-01-01'),
    link('B', 'not-an-id', 'pdf', '2026-01-01'),
  ]);
  assert.equal(cvs.get('A')?.versionId, '068Sr000001bbbbIAA');
  assert.equal(cvs.has('B'), false);
  assert.equal(sfCvKey('068Sr000001bbbbIAA'), 'sf:068Sr000001bbbbIAA');
  assert.ok(isSfCvKey('sf:068Sr000001bbbbIAA'));
  assert.ok(!isSfCvKey('sf:../etc') && !isSfCvKey('post-scan/x/y.pdf'));
  assert.equal(sfCvFileName(cvs.get('A')!), 'קורות חיים 2026.docx');
});

test('the copy follows the Contact: only what differs is written', () => {
  const r = contactToCandidate(REGISTERED, ctx());
  assert.ok(r.ok);
  const stored = { first_name: 'דנה', last_name: 'לוי', email: 'dana@example.test', phone_number: '0501234567', date_of_birth: new Date('1990-05-01T00:00:00Z'),
    gender: 'female', city_symbol: 8600, skills: [SKILL_B, SKILL_A] };
  assert.deepEqual(changedCandidateColumns(stored, r.candidate), {});
  assert.deepEqual(changedCandidateColumns({ ...stored, city_symbol: 4000 }, r.candidate), { city_symbol: 8600 });
});

test('an account made here with the same email: only its empty fields are filled, never the email', () => {
  const r = contactToCandidate(REGISTERED, ctx());
  assert.ok(r.ok);
  const fill = fillEmptyColumns({ first_name: 'Dana', last_name: 'Levi', email: 'x@y.test', phone_number: null, date_of_birth: null, gender: '', city_symbol: 0, skills: [] }, r.candidate);
  assert.deepEqual(Object.keys(fill).sort(), ['city_symbol', 'date_of_birth', 'gender', 'phone_number', 'skills']);
});

test('after the cutover the Contact gets every value, never cleared, never its id, Account or Beta', () => {
  const patch = fullContactPatch({
    FirstName: 'Dana', Phone: '', ID_cambium__c: 'new', AccountId: '001x', Beta__c: true, gender_cambium__c: 'female',
    CV_link_cambium__c: 'sf:068Sr000001bbbbIAA', email_cambium__c: null,
  }, 'Beta__c');
  assert.deepEqual(patch, { FirstName: 'Dana', gender_cambium__c: 'female' });
  assert.deepEqual(fullContactPatch({ CV_link_cambium__c: 'post-scan/t/cv.pdf' }, 'Beta__c'), { CV_link_cambium__c: 'post-scan/t/cv.pdf' });
});

const GOOD = {
  ENABLE_SALESFORCE: 'true', SALESFORCE_LOGIN_URL: 'https://skeelz.my.salesforce.com', SALESFORCE_CLIENT_ID: 'key', SALESFORCE_CLIENT_SECRET: 'secret',
  SALESFORCE_CONTACTS_ACCOUNT_ID: '0018d00000AbCdEAAV', SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID: '0018d00000AbCdFAAV',
  SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID: '0128d000000AbCdAAA', SALESFORCE_CASE_ACCOUNT_ID: '0018d00000AbCdGAAV',
  SALESFORCE_CASE_RECORD_TYPE_ID: '0128d000000AbCeAAA',
};

test('settings: candidates mode off by default; the accounts default to the candidates\' Account', () => {
  const s = readSalesforceSettings(GOOD);
  assert.equal(s.legacyCandidatesMode, 'off');
  assert.deepEqual(s.legacyCandidateAccounts, ['0018d00000AbCdEAAV']);
  assert.equal(s.legacyCandidatesMirrorMinutes, 60, 'hourly by default');
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_CANDIDATES_MIRROR_MINUTES: '1440' }).legacyCandidatesMirrorMinutes, 1440);
  assert.ok(readSalesforceSettings({ ...GOOD, LEGACY_CANDIDATES_MIRROR_MINUTES: '1' }).problems.some((p) => p.includes('LEGACY_CANDIDATES_MIRROR_MINUTES')));
  const t = readSalesforceSettings({ ...GOOD, LEGACY_CANDIDATES_MODE: 'Mirror', LEGACY_CANDIDATE_ACCOUNTS: `${CANDIDATES}, ${RETRAIN}` });
  assert.equal(t.legacyCandidatesMode, 'mirror');
  assert.deepEqual(t.legacyCandidateAccounts, [CANDIDATES, RETRAIN]);
  assert.equal(t.enabled, true);
  const bad = readSalesforceSettings({ ...GOOD, LEGACY_CANDIDATES_MODE: 'copy', LEGACY_CANDIDATE_ACCOUNTS: '003abc' });
  assert.equal(bad.enabled, false);
  assert.ok(bad.problems.some((p) => p.includes('LEGACY_CANDIDATES_MODE')));
  assert.ok(bad.problems.some((p) => p.includes('LEGACY_CANDIDATE_ACCOUNTS')));
});
