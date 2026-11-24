// security/employer.ts: the posting setting, an employer's own details, edit requests (fields, diff, apply), claiming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  postingRefusal, normalizeEmployerPosting, isEmployerPostingMode, DEFAULT_EMPLOYER_POSTING, checkEmployerProfile,
  checkEditRequest, compareEditRequest, changesToJobUpdate, jobToEditable, htmlToPlainText, mayClaimSubmission, EDITABLE_JOB_FIELDS,
} from '../../src/security/employer.ts';
import { descriptionToHtml } from '../../src/services/jobSubmissionRules.ts';

const SKILL = 'a'.repeat(24);
const SKILL2 = 'b'.repeat(24);
const job = {
  title: 'מפתח/ת', companyName: 'חברה בע״מ', citySymbol: 3000, jobScope: ['FullTime'], requiredSkills: [SKILL],
  description: '<p dir="auto">שורה ראשונה<br>שורה שנייה</p><p dir="auto">פסקה &amp; עוד</p>',
  externalLink: 'https://example.com/apply', contactPersonEmail: 'jobs@example.com',
};
const current = jobToEditable(job);

test('the posting setting: open by default, account_required refuses anyone but an employer', () => {
  assert.equal(DEFAULT_EMPLOYER_POSTING, 'open');
  assert.equal(normalizeEmployerPosting(undefined), 'open');
  assert.equal(normalizeEmployerPosting({ mode: 'weird' }), 'open');
  assert.equal(normalizeEmployerPosting({ mode: 'account_required' }), 'account_required');
  assert.ok(isEmployerPostingMode('open') && isEmployerPostingMode('account_required') && !isEmployerPostingMode('closed'));
  for (const role of [null, undefined, 'user', 'employer', 'content_manager', 'admin']) assert.equal(postingRefusal('open', role), null, String(role));
  assert.equal(postingRefusal('account_required', null), 'sign_in');
  assert.equal(postingRefusal('account_required', undefined), 'sign_in');
  assert.equal(postingRefusal('account_required', 'employer'), null);
  for (const role of ['user', 'content_manager', 'admin']) assert.equal(postingRefusal('account_required', role), 'employer_only', role);
});

test("an employer's details: required fields, caps, Israeli phone, allowlist", () => {
  const ok = checkEmployerProfile({ firstName: 'דנה', lastName: 'לוי', companyName: 'אקמה', phone: '050-123-4567', role: 'admin', email: 'x@y.z' }, { requireAll: true });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(Object.keys(ok.values).sort(), ['companyName', 'firstName', 'lastName', 'phone']);
    assert.equal(ok.values.phone, '0501234567');
  }
  const missing = checkEmployerProfile({ firstName: 'דנה' }, { requireAll: true });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.bad.sort(), ['companyName', 'lastName', 'phone']);
  const bad = checkEmployerProfile({ firstName: 'D1', phone: '123', companyName: 'x' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.bad.sort(), ['companyName', 'firstName', 'phone']);
  const partial = checkEmployerProfile({ companyName: 'חברה חדשה', jobTitle: '' });
  assert.equal(partial.ok, true);
  if (partial.ok) assert.deepEqual(partial.values, { companyName: 'חברה חדשה', jobTitle: null });
});

test('the job as the employer edits it: plain text, the public application email', () => {
  assert.equal(current.description, 'שורה ראשונה\nשורה שנייה\n\nפסקה & עוד');
  assert.equal(current.publicEmail, 'jobs@example.com');
  assert.equal(htmlToPlainText('<script>x</script><b>a</b>'), 'xa');
});

test('edit requests: only the allowed fields, validated, only what changed', () => {
  assert.deepEqual([...EDITABLE_JOB_FIELDS].sort(), ['citySymbol', 'companyName', 'description', 'externalLink', 'jobScope', 'publicEmail', 'requiredSkills', 'thresholdCondition', 'title']);
  for (const k of ['status', 'isSponsored', 'publishDate', 'comments', 'guestModeOverride', 'pinnedAt', 'contactPersonPhone']) {
    const r = checkEditRequest({ [k]: 'x' }, current);
    assert.equal(r.ok, false, k);
    if (!r.ok) assert.equal((r.errors as any)._, 'bad_field', k);
  }
  const same = checkEditRequest({ title: current.title, requiredSkills: [SKILL] }, current);
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal((same.errors as any)._, 'no_changes');
  const invalid = checkEditRequest({ title: 'x', publicEmail: 'not-an-email' }, current);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.deepEqual(invalid.errors, { title: 'too_short', publicEmail: 'invalid' });
  const r = checkEditRequest({ title: 'מפתח/ת בכיר/ה', requiredSkills: [SKILL2, SKILL], companyName: current.companyName, externalLink: '' }, current);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.fields.sort(), ['externalLink', 'requiredSkills', 'title']);
    assert.equal(r.changes.externalLink, null);
  }
});

test('the comparison shows base, current and requested, and flags a field that changed since', () => {
  const now = { ...current, title: 'שונה בינתיים' };
  const cmp = compareEditRequest({ title: 'חדש', citySymbol: 5000 }, { title: current.title, citySymbol: 3000 }, now);
  assert.deepEqual(cmp.map((c) => [c.field, c.changedSince]), [['title', true], ['citySymbol', false]]);
  assert.equal(cmp[0].requested, 'חדש');
  assert.equal(cmp[0].current, 'שונה בינתיים');
});

test('approval turns the request into a job update: safe HTML, the public email field', () => {
  const u = changesToJobUpdate({ description: 'שורה <b>\n\nפסקה', publicEmail: null, title: 'כותרת' }, descriptionToHtml);
  assert.deepEqual(Object.keys(u).sort(), ['contactPersonEmail', 'description', 'title']);
  assert.equal(u.contactPersonEmail, null);
  assert.ok(!String(u.description).includes('<b>'));
  assert.ok(String(u.description).includes('&lt;b&gt;'));
});

test('claiming an earlier anonymous submission: only by the same (verified) email, only if unowned', () => {
  const me = { id: '1', email: 'Boss@Example.com' };
  assert.equal(mayClaimSubmission({ contactEmail: 'boss@example.com', ownerId: null }, me), true);
  assert.equal(mayClaimSubmission({ contactEmail: 'boss@example.com', ownerId: '2' }, me), false);
  assert.equal(mayClaimSubmission({ contactEmail: 'other@example.com', ownerId: null }, me), false);
  assert.equal(mayClaimSubmission({ contactEmail: 'boss@example.com', ownerId: null }, { id: '1', email: '' }), false);
});
