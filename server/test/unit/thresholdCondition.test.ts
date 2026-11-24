// Unit tests for the threshold condition (תנאי סף): validation of the text, the server-side refusal, what is stored,
// and its place in the employer form / edit requests / public shape. No DB, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkThresholdCondition,
  cleanThresholdText,
  isThresholdConfirmed,
  THRESHOLD_CONDITION_LIMITS,
  thresholdConditionOf,
  thresholdRecord,
  thresholdRefusal,
} from '../../src/models/schemas/thresholdCondition.ts';
import { validateSubmission } from '../../src/services/jobSubmissionRules.ts';
import { checkEditRequest, EDITABLE_JOB_FIELDS, jobToEditable, changesToJobUpdate } from '../../src/security/employer.ts';
import { PUBLIC_JOB_KEYS, toPublicJob } from '../../src/public/publicJob.ts';

test('text: plain text only — tags, control characters and bidi overrides go, newlines stay', () => {
  assert.equal(cleanThresholdText('  ניסיון של <b>שנתיים</b> במכירות  '), 'ניסיון של שנתיים במכירות');
  assert.equal(cleanThresholdText('<script>alert(1)</script>רישיון עו"ד'), 'alert(1)רישיון עו"ד');
  assert.equal(cleanThresholdText('<img src=x onerror=alert(1)>קורס הנהלת חשבונות'), 'קורס הנהלת חשבונות');
  assert.equal(cleanThresholdText('א‮ב\u0007ג'), 'אבג');
  assert.equal(cleanThresholdText('שורה 1\r\n\r\n\r\n\r\nשורה 2'), 'שורה 1\n\nשורה 2');
  // Comparisons are text, not tags.
  assert.equal(cleanThresholdText('ניסיון < 2 שנים > 1'), 'ניסיון < 2 שנים > 1');
  assert.equal(cleanThresholdText(42), '');
  assert.equal(cleanThresholdText(null), '');
});

test('validation: empty → no condition; too short / too long / not a string → refused', () => {
  assert.deepEqual(checkThresholdCondition(undefined), { ok: true, value: null });
  assert.deepEqual(checkThresholdCondition(null), { ok: true, value: null });
  assert.deepEqual(checkThresholdCondition('   '), { ok: true, value: null });
  assert.deepEqual(checkThresholdCondition('<p></p>'), { ok: true, value: null });
  assert.deepEqual(checkThresholdCondition('אב'), { ok: false, error: 'too_short' });
  assert.deepEqual(checkThresholdCondition('א'.repeat(THRESHOLD_CONDITION_LIMITS.max + 1)), { ok: false, error: 'too_long' });
  assert.deepEqual(checkThresholdCondition('א'.repeat(THRESHOLD_CONDITION_LIMITS.max)), { ok: true, value: 'א'.repeat(THRESHOLD_CONDITION_LIMITS.max) });
  assert.deepEqual(checkThresholdCondition(['x']), { ok: false, error: 'invalid' });
  assert.deepEqual(checkThresholdCondition(123), { ok: false, error: 'invalid' });
  assert.deepEqual(checkThresholdCondition(' רישיון עריכת דין בתוקף '), { ok: true, value: 'רישיון עריכת דין בתוקף' });
});

test('confirmation: only the boolean true counts', () => {
  assert.equal(isThresholdConfirmed({ thresholdConfirmed: true }), true);
  for (const v of ['true', 1, 'on', 'yes', {}, [], null, undefined, false]) {
    assert.equal(isThresholdConfirmed({ thresholdConfirmed: v }), false, String(v));
  }
  assert.equal(isThresholdConfirmed(null), false);
  assert.equal(isThresholdConfirmed('thresholdConfirmed'), false);
});

test('refusal: a job with a condition needs the confirmation; a job without one does not', () => {
  assert.equal(thresholdRefusal(null, false), null);
  assert.equal(thresholdRefusal('', false), null);
  assert.equal(thresholdRefusal('<br>', false), null);
  assert.equal(thresholdRefusal(null, true), null);
  assert.equal(thresholdRefusal('ניסיון במכירות', false), 'threshold_not_confirmed');
  assert.equal(thresholdRefusal('ניסיון במכירות', true), null);
});

test('stored with the application: confirmed + time only when the job had a condition', () => {
  const now = new Date('2026-11-17T10:00:00Z');
  assert.deepEqual(thresholdRecord('ניסיון במכירות', true, now), { confirmed: true, at: now });
  assert.deepEqual(thresholdRecord(null, true, now), { confirmed: false, at: null });
  assert.deepEqual(thresholdRecord('ניסיון במכירות', false, now), { confirmed: false, at: null });
});

test('stored value out: text or null, capped', () => {
  assert.equal(thresholdConditionOf(null), null);
  assert.equal(thresholdConditionOf(''), null);
  assert.equal(thresholdConditionOf('x'.repeat(900))!.length, THRESHOLD_CONDITION_LIMITS.max);
});

const FORM = {
  title: 'מנהלת חשבונות', companyName: 'חברה בע"מ', citySymbol: 5000, jobScope: ['FullTime'], requiredSkills: ['0123456789abcdef01234567'],
  description: 'תיאור משרה ארוך מספיק כדי לעבור את המינימום של שלושים תווים.', contactName: 'דנה כהן', contactEmail: 'dana@example.com',
  contactPhone: '050-1234567', consent: true,
};

test('employer form: "תנאי סף" is optional, plain text, length-checked', () => {
  assert.equal(validateSubmission(FORM).value.thresholdCondition, null);
  assert.deepEqual(validateSubmission(FORM).errors, {});
  const r = validateSubmission({ ...FORM, thresholdCondition: ' קורס <i>הנהלת חשבונות</i> סוג 2 ' });
  assert.deepEqual(r.errors, {});
  assert.equal(r.value.thresholdCondition, 'קורס הנהלת חשבונות סוג 2');
  assert.equal(validateSubmission({ ...FORM, thresholdCondition: '' }).value.thresholdCondition, null);
  assert.equal(validateSubmission({ ...FORM, thresholdCondition: 'x'.repeat(501) }).errors.thresholdCondition, 'too_long');
  assert.equal(validateSubmission({ ...FORM, thresholdCondition: 'xy' }).errors.thresholdCondition, 'too_short');
  // Staff edits of a pending submission (partial): only when sent.
  assert.ok(!('thresholdCondition' in validateSubmission({ title: 'כותרת חדשה' }, { partial: true }).value));
});

test('edit requests: the employer may ask to set, change or clear it; the diff and the job update carry it', () => {
  assert.ok((EDITABLE_JOB_FIELDS as readonly string[]).includes('thresholdCondition'));
  const current = jobToEditable({ title: 'משרה', companyName: 'חברה', citySymbol: 5000, jobScope: ['FullTime'], requiredSkills: [],
    description: '<p>תיאור</p>', externalLink: null, contactPersonEmail: null, thresholdCondition: null });
  assert.equal(current.thresholdCondition, null);
  const set = checkEditRequest({ thresholdCondition: 'רישיון עריכת דין' }, current);
  assert.ok(set.ok);
  if (set.ok) {
    assert.deepEqual(set.fields, ['thresholdCondition']);
    assert.deepEqual(changesToJobUpdate(set.changes, (t) => t), { thresholdCondition: 'רישיון עריכת דין' });
  }
  const same = checkEditRequest({ thresholdCondition: '' }, current);
  assert.ok(!same.ok); // nothing changed
  const withOne = { ...current, thresholdCondition: 'רישיון עריכת דין' };
  const cleared = checkEditRequest({ thresholdCondition: '' }, withOne);
  assert.ok(cleared.ok && cleared.changes.thresholdCondition === null);
  const bad = checkEditRequest({ thresholdCondition: 'x'.repeat(600) }, current);
  assert.ok(!bad.ok);
});

test('public API / MCP shape: thresholdCondition is a public key, text or null', () => {
  assert.ok((PUBLIC_JOB_KEYS as readonly string[]).includes('thresholdCondition'));
  const base: any = { _id: '0123456789abcdef01234567', jobId: 7, title: 't', companyName: 'c', description: '<p>d</p>', jobScope: [],
    publishDate: new Date('2026-01-01'), status: 'Active', requiredSkills: [], isSponsored: false, isMarked: false, isSelfApply: false };
  assert.equal(toPublicJob(base)!.thresholdCondition, null);
  assert.equal(toPublicJob({ ...base, thresholdCondition: 'ניסיון <b>במכירות</b>' })!.thresholdCondition, 'ניסיון במכירות');
});
