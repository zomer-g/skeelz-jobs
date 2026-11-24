// The cutover from the existing site (owner, 20.11.2026): its jobs read from Salesforce (legacyJobsPure), the Beta
// switch, the candidate's adopted Contact, the job link and the settings. No network, no DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caseToJob, changedColumns, decodeEntities, looksLikeHtml, nextWatermark, parseScope, parseSkills, parseStatus, plainText, publicToJob,
  soqlDateTime, splitComments, textToHtml, isLegacyJobId, CaseContext, jobNumberFromLink,
} from '../../src/services/legacyJobsPure.js';
import { readSalesforceSettings, salesforceBootMessage } from '../../src/config/salesforceSettings.js';
import {
  adoptedContactPatch, betaMark, formatJobToSalesforceJobApplicationsCase, formatJobToSalesforceJobCase, ADOPTED_FILL_IF_EMPTY,
} from '../../src/utils/salesforceUtils.js';
import { jobNumberFloor, DEFAULT_JOB_NUMBER_FLOOR } from '../../src/config/db.js';

const SKILL_A = '677e68ea063529e50d3e9822';
const SKILL_B = '677e68ea063529e50d3e9826';
const ctx = (over: Partial<CaseContext> = {}): CaseContext => ({
  skills: { ids: new Set([SKILL_A, SKILL_B]), byName: new Map([['עבודה בצוות', SKILL_A], ['excel', SKILL_B]]) },
  cityByName: new Map([['רמת גן', 8600], ['חיפה', 4000]]),
  sanitize: (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ''),
  now: new Date('2026-11-20T10:00:00Z'),
  ...over,
});
const PID = '6afab479671d52ff0039eb80';
const CASE = {
  Id: '500Sr00000luyHoIAI', PID_cambium__c: PID, Position_cambium__c: 'רכז.ת אקדמי', company_cambium__c: 'מכללה', citySymbol_cambium__c: '8600',
  PLocation_cambium__c: 'רמת גן', PTime_cambium__c: 'FullTime', PSkills_cambium__c: `${SKILL_A},${SKILL_B}`, PDescription_cambium__c: 'שורה 1\nשורה 2\n\nפסקה',
  PComments_cambium__c: 'משרה בתשלום\nשכר כ 10,500 ש&quot;ח', PFullName_cambium__c: 'איש קשר', PPhone_cambium__c: '0500000000', PEmail_cambium__c: 'hr@example.test',
  PStatus__c: 'Active', PCreatedDate_cambium__c: '2026-11-16T07:44:57.000Z', PModifiedDate_cambium__c: '2026-11-17T20:57:07.000Z',
  isSponserd_cambium__c: true, isMarked_cambium__c: true, isSelfApply_cambium__c: false,
  CreatedDate: '2026-11-16T07:44:57.000+0000', LastModifiedDate: '2026-11-17T20:57:08.000+0000',
};

test('a Position Case of the existing site becomes the same job (same id, its fields, status)', () => {
  const r = caseToJob(CASE, ctx());
  assert.ok(r.ok);
  const j = r.job;
  assert.equal(j.id, PID);
  assert.equal(j.title, 'רכז.ת אקדמי');
  assert.equal(j.citySymbol, 8600);
  assert.deepEqual(j.jobScope, ['FullTime']);
  assert.deepEqual(j.requiredSkills, [SKILL_A, SKILL_B]);
  assert.equal(j.status, 'Active');
  assert.equal(j.isSponsored, true);
  assert.equal(j.isMarked, true);
  assert.equal(j.comments, 'משרה בתשלום\nשכר כ 10,500 ש"ח', 'HTML entities decoded');
  assert.equal(j.description, '<p>שורה 1<br>שורה 2</p><p>פסקה</p>', 'plain text → paragraphs');
  assert.equal(j.publishDate.toISOString(), '2026-11-16T07:44:57.000Z');
  assert.equal(j.updatedAt.toISOString(), '2026-11-17T20:57:08.000Z', 'the later of the site\'s time and the Case\'s');
  assert.equal(j.sfId, '500Sr00000luyHoIAI');
  assert.equal(j.jobNumber, null, 'Salesforce has no job number');
});

test('the job number comes from the Case\'s link when the board does not have the job', () => {
  const r = caseToJob({ ...CASE, PLink_cambium__c: 'jobs.skeelz.co.il/job/1910' }, ctx());
  assert.ok(r.ok);
  assert.equal(r.job.jobNumber, 1910);
  const board = caseToJob({ ...CASE, PLink_cambium__c: 'jobs.skeelz.co.il/job/1910' }, ctx({ publicJob: { _id: PID, jobId: 1900 } }));
  assert.ok(board.ok);
  assert.equal(board.job.jobNumber, 1900, 'the board wins');
  assert.equal(jobNumberFromLink('https://jobs.skeelz.co.il/job/1794?x=1'), 1794);
  assert.equal(jobNumberFromLink('https://jobs.skeelz.co.il/job/6afab479671d52ff0039eb80'), null);
  assert.equal(jobNumberFromLink(''), null);
  assert.equal(jobNumberFromLink('/job/0'), null);
});

test('the public board adds the job number and its formatted description', () => {
  const html = '<div><p>תיאור <b>מעוצב</b></p></div>';
  const r = caseToJob(CASE, ctx({ publicJob: { _id: PID, jobId: 1900, description: html, externalLink: 'https://apply.example.test/x', uploadBy: 'staff@example.test' } }));
  assert.ok(r.ok);
  assert.equal(r.job.jobNumber, 1900);
  assert.equal(r.job.description, html);
  assert.equal(r.job.externalLink, 'https://apply.example.test/x');
  assert.equal(r.job.uploadBy, 'staff@example.test');
});

test('a stored description that says the same is kept (no reformatting on every read)', () => {
  const stored = '<ul><li>שורה 1</li><li>שורה 2</li></ul><p>פסקה</p>';
  const r = caseToJob({ ...CASE, PDescription_cambium__c: '• שורה 1\n• שורה 2\n\nפסקה' }, ctx({ existingDescription: stored }));
  assert.ok(r.ok);
  assert.equal(r.job.description, stored);
  const changed = caseToJob({ ...CASE, PDescription_cambium__c: 'טקסט אחר' }, ctx({ existingDescription: stored }));
  assert.ok(changed.ok);
  assert.equal(changed.job.description, '<p>טקסט אחר</p>');
  const html = caseToJob({ ...CASE, PDescription_cambium__c: '<p>a</p><script>x</script>' }, ctx());
  assert.ok(html.ok);
  assert.equal(html.job.description, '<p>a</p>', 'HTML from Salesforce is cleaned');
});

test('tolerant field forms: names or ids, commas or semicolons, Hebrew scope words, city by name', () => {
  assert.deepEqual(parseScope('FullTime;PartialTime'), ['FullTime', 'PartialTime']);
  assert.deepEqual(parseScope('מלאה'), ['FullTime']);
  assert.deepEqual(parseScope('משרה חלקית, ???'), ['PartialTime']);
  assert.deepEqual(parseScope(null), []);
  const known = ctx().skills;
  assert.deepEqual(parseSkills(`${SKILL_A.toUpperCase()}; עבודה בצוות ;Excel; לא ידוע; 000000000000000000000000`, known), [SKILL_A, SKILL_B]);
  const r = caseToJob({ ...CASE, citySymbol_cambium__c: '', PLocation_cambium__c: 'חיפה' }, ctx());
  assert.ok(r.ok);
  assert.equal(r.job.citySymbol, 4000);
});

test('status: Active / Suspended / Closed; anything else (the oldest, empty) is closed', () => {
  assert.equal(parseStatus('Active'), 'Active');
  assert.equal(parseStatus('suspended'), 'Suspended');
  assert.equal(parseStatus('Closed'), 'Closed');
  assert.equal(parseStatus(null), 'Closed');
  assert.equal(parseStatus('Other'), 'Closed');
});

test('skipped: no valid id, no title, no city', () => {
  assert.deepEqual(caseToJob({ ...CASE, PID_cambium__c: '1794' }, ctx()), { ok: false, code: 'bad_pid' });
  assert.deepEqual(caseToJob({ ...CASE, PID_cambium__c: "x' OR 1=1" }, ctx()), { ok: false, code: 'bad_pid' });
  assert.deepEqual(caseToJob({ ...CASE, Position_cambium__c: '' }, ctx()), { ok: false, code: 'no_title' });
  assert.deepEqual(caseToJob({ ...CASE, citySymbol_cambium__c: '', PLocation_cambium__c: 'לא קיים' }, ctx()), { ok: false, code: 'no_city' });
  assert.equal(isLegacyJobId(PID), true);
  assert.equal(isLegacyJobId('6afab479671d52ff0039eb8'), false);
});

test('comments: the external apply link line (as this site writes it) becomes the external link', () => {
  assert.deepEqual(splitComments('הערה\nקישור חיצוני להגשה: https://x.example.test/a'), { comments: 'הערה', externalLink: 'https://x.example.test/a' });
  assert.deepEqual(splitComments('קישור חיצוני להגשה: javascript:alert(1)'), { comments: 'קישור חיצוני להגשה: javascript:alert(1)', externalLink: null });
  assert.equal(decodeEntities('&quot;a&quot; &amp; &#1488; &#x5D1; &unknown;'), '"a" & א ב &unknown;');
  assert.equal(plainText('<p>a&nbsp;b</p><ul><li>c</li></ul>'), 'a b c');
  assert.equal(looksLikeHtml('a < b'), false);
  assert.equal(looksLikeHtml('<p>a</p>'), true);
  assert.equal(textToHtml('<b>&'), '<p>&lt;b&gt;&amp;</p>', 'text is escaped, never HTML');
});

test('changed columns: only what differs; same values = no write', () => {
  const r = caseToJob(CASE, ctx());
  assert.ok(r.ok);
  const j = r.job;
  const stored: Record<string, unknown> = {
    title: j.title, company_name: j.companyName, city_symbol: j.citySymbol, job_scope: [...j.jobScope], required_skills: [...j.requiredSkills],
    description: j.description, comments: j.comments, external_link: null, contact_person_name: j.contactPersonName,
    contact_person_phone: j.contactPersonPhone, contact_person_email: j.contactPersonEmail, status: 'Active', is_sponsored: true,
    is_marked: true, is_self_apply: false, guest_mode_override: null, publish_date: new Date(j.publishDate), upload_by: null,
  };
  assert.deepEqual(changedColumns(stored, j), []);
  const closed = caseToJob({ ...CASE, PStatus__c: 'Closed', isSelfApply_cambium__c: true }, ctx());
  assert.ok(closed.ok);
  assert.deepEqual(changedColumns(stored, closed.job).map((c) => c.column).sort(), ['guest_mode_override', 'is_self_apply', 'status']);
});

test('a job on the public board without a Case is read from the board alone', () => {
  const r = publicToJob({ _id: PID, jobId: '1901', title: 'כותרת', citySymbol: 5000, description: '<p>x</p>', jobScope: ['PartialTime', 'X'],
    requiredSkills: [SKILL_A, '000000000000000000000000'], status: 'Active' }, ctx());
  assert.ok(r.ok);
  assert.equal(r.job.jobNumber, 1901);
  assert.deepEqual(r.job.jobScope, ['PartialTime']);
  assert.deepEqual(r.job.requiredSkills, [SKILL_A]);
  assert.equal(r.job.sfId, null);
});

test('watermark: newest change minus a margin, never backwards; SOQL time literal is strict', () => {
  assert.equal(nextWatermark(null, []), null);
  assert.equal(nextWatermark(null, ['2026-11-17T20:57:08.000+0000', '2026-11-16T07:44:57.000+0000']), '2026-11-17T20:55:08.000Z');
  assert.equal(nextWatermark('2026-11-18T00:00:00.000Z', ['2026-11-17T20:57:08.000Z']), '2026-11-18T00:00:00.000Z');
  assert.equal(soqlDateTime('2026-11-17T20:55:08.123Z'), '2026-11-17T20:55:08Z');
  assert.throws(() => soqlDateTime("2026' OR Id != null"));
});

// ---- settings ----
const GOOD = {
  ENABLE_SALESFORCE: 'true', SALESFORCE_LOGIN_URL: 'https://skeelz.my.salesforce.com', SALESFORCE_CLIENT_ID: 'key', SALESFORCE_CLIENT_SECRET: 'secret',
  SALESFORCE_CONTACTS_ACCOUNT_ID: '0018d00000AbCdEAAV', SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID: '0018d00000AbCdFAAV',
  SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID: '0128d000000AbCdAAA', SALESFORCE_CASE_ACCOUNT_ID: '0018d00000AbCdGAAV',
  SALESFORCE_CASE_RECORD_TYPE_ID: '0128d000000AbCeAAA',
};

test('settings: Beta mark on by default, off only with SALESFORCE_BETA_MARK=false', () => {
  assert.equal(readSalesforceSettings(GOOD).betaMarkOn, true);
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_BETA_MARK: 'false' }).betaMarkOn, false);
  assert.equal(readSalesforceSettings({ ...GOOD, SALESFORCE_BETA_MARK: 'TRUE' }).betaMarkOn, true);
  const bad = readSalesforceSettings({ ...GOOD, SALESFORCE_BETA_MARK: 'no' });
  assert.equal(bad.enabled, false);
  assert.match(bad.problems.join(' '), /SALESFORCE_BETA_MARK/);
});

test('settings: LEGACY_JOBS_MODE off by default; mirror / owned; anything else turns Salesforce off', () => {
  assert.equal(readSalesforceSettings(GOOD).legacyJobsMode, 'off');
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MODE: 'mirror' }).legacyJobsMode, 'mirror');
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MODE: 'Owned' }).legacyJobsMode, 'owned');
  const bad = readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MODE: 'both' });
  assert.equal(bad.enabled, false);
  assert.equal(bad.legacyJobsMode, 'off');
  assert.match(salesforceBootMessage(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MODE: 'mirror' })).text, /mirror/);
});

test('settings: the public API must be https (a local mock only in DEV_MODE); minutes 1–60', () => {
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_PUBLIC_API: 'https://jobs.skeelz.co.il/api/' }).legacyPublicApi, 'https://jobs.skeelz.co.il/api');
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_PUBLIC_API: 'http://jobs.skeelz.co.il/api' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_PUBLIC_API: 'http://127.0.0.1:3197/api' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, DEV_MODE: 'true', LEGACY_PUBLIC_API: 'http://127.0.0.1:3197/api' }).enabled, true);
  assert.equal(readSalesforceSettings(GOOD).legacyMirrorMinutes, 5);
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MIRROR_MINUTES: '15' }).legacyMirrorMinutes, 15);
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MIRROR_MINUTES: '0' }).enabled, false);
  assert.equal(readSalesforceSettings({ ...GOOD, LEGACY_JOBS_MIRROR_MINUTES: '2.5' }).enabled, false);
});

// ---- Beta, adopted Contacts, the job link, the candidate key ----
const describe = { name: 'Contact', createable: true, updateable: true, fields: [{ name: 'Beta__c', type: 'boolean', length: 0, createable: true, updateable: true, filterable: true }] };

test('Beta off: nothing about Beta is written and the field is not required', () => {
  assert.deepEqual(betaMark(describe as any, 'Beta__c', true), { Beta__c: true });
  assert.deepEqual(betaMark(describe as any, 'Beta__c', false), {});
  assert.deepEqual(betaMark(null, 'Beta__c', false), {});
  assert.throws(() => betaMark(null, 'Beta__c', true), (e: any) => e.code === 'beta_field_missing');
});

test('an adopted Contact: only empty fields are filled, the CV link kept current, nothing cleared or overwritten', () => {
  const body = { FirstName: 'דנה', LastName: 'כהן', Email: 'dana@example.test', Phone: '0501111111', AccountId: '001x', ID_cambium__c: 'NEWID',
    gender_cambium__c: 'female', skills_cambium__c: 'a,b', CV_link_cambium__c: 'cv/new.pdf', citySymbol_cambium__c: '' };
  const current = { FirstName: 'Dana', Phone: '', ID_cambium__c: 'OLDID', gender_cambium__c: null, skills_cambium__c: 'x', CV_link_cambium__c: 'cv/old.pdf', citySymbol_cambium__c: '5000' };
  assert.deepEqual(adoptedContactPatch(body, current), { Phone: '0501111111', gender_cambium__c: 'female', CV_link_cambium__c: 'cv/new.pdf' });
  assert.deepEqual(adoptedContactPatch({ ...body, CV_link_cambium__c: '' }, current).CV_link_cambium__c, undefined, 'no CV → the old link stays');
  assert.equal(adoptedContactPatch(body, { ...current, ID_cambium__c: '' }).ID_cambium__c, 'NEWID', 'an empty key gets this site\'s id');
  for (const never of ['LastName', 'Email', 'AccountId']) assert.ok(!(ADOPTED_FILL_IF_EMPTY as readonly string[]).includes(never), never);
  assert.deepEqual(adoptedContactPatch(body, current, ['ID_Number__c']), adoptedContactPatch(body, current), 'no ID number in the body: not sent');
});

test('the job link is /job/<id> (the existing site\'s form), the application names the adopted Contact\'s key', () => {
  const c = formatJobToSalesforceJobCase({ _id: PID, jobId: 1900, title: 't', status: 'Active' } as any, null);
  assert.match(c.PLink_cambium__c, new RegExp(`/job/${PID}$`));
  const own = formatJobToSalesforceJobApplicationsCase({ _id: 'a1', jobId: PID, userId: 'u1' } as any, '003x');
  assert.equal(own.A_CID_cambium__c, 'u1');
  const adopted = formatJobToSalesforceJobApplicationsCase({ _id: 'a1', jobId: PID, userId: 'u1', candidateKey: 'OLDID' } as any, '003x');
  assert.equal(adopted.A_CID_cambium__c, 'OLDID');
  assert.equal(adopted.A_PID_cambium__c, PID);
});

test('job number floor: default 3000, a bad value falls back', () => {
  assert.equal(jobNumberFloor(undefined), DEFAULT_JOB_NUMBER_FLOOR);
  assert.equal(DEFAULT_JOB_NUMBER_FLOOR, 3000);
  assert.equal(jobNumberFloor('5000'), 5000);
  assert.equal(jobNumberFloor('0'), 0);
  assert.equal(jobNumberFloor('-1'), DEFAULT_JOB_NUMBER_FLOOR);
  assert.equal(jobNumberFloor('abc'), DEFAULT_JOB_NUMBER_FLOOR);
});
