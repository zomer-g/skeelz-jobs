// Unit tests for the employer job form rules (run: npx tsc && npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission, isHoneypotHit, descriptionToHtml, cleanReason, cleanText } from '../dist/services/jobSubmissionRules.js';

const ok = {
  title: 'מפתח/ת Full Stack',
  companyName: 'חברה בע"מ',
  citySymbol: 5000,
  jobScope: ['FullTime'],
  requiredSkills: ['0123456789abcdef01234567'],
  description: 'תיאור המשרה עם מספיק טקסט כדי לעבור את המינימום.\n\nשורה שנייה.',
  externalLink: '',
  publicEmail: '',
  contactName: 'דנה כהן',
  contactEmail: 'Dana@Example.co.il',
  contactPhone: '050-1234567',
  consent: true,
};

test('a valid submission passes and is cleaned', () => {
  const { value, errors } = validateSubmission(ok);
  assert.deepEqual(errors, {});
  assert.equal(value.contactEmail, 'dana@example.co.il');
  assert.equal(value.externalLink, null);
  assert.equal(value.publicEmail, null);
  assert.equal(value.citySymbol, 5000);
});

test('missing consent, bad email, bad phone, bad link, unknown scope are refused', () => {
  const { errors } = validateSubmission({ ...ok, consent: 'yes', contactEmail: 'x@', contactPhone: '12ab', externalLink: 'javascript:alert(1)', jobScope: ['Other'] });
  assert.equal(errors.consent, 'required');
  assert.equal(errors.contactEmail, 'invalid');
  assert.equal(errors.contactPhone, 'invalid');
  assert.equal(errors.externalLink, 'invalid');
  assert.equal(errors.jobScope, 'invalid');
});

test('size limits', () => {
  const { errors } = validateSubmission({ ...ok, title: 'x'.repeat(31), description: 'y'.repeat(5001), requiredSkills: Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(24, '0')) });
  assert.equal(errors.title, 'too_long');
  assert.equal(errors.description, 'too_long');
  assert.equal(errors.requiredSkills, 'too_long');
  assert.equal(validateSubmission({ ...ok, contactPhone: '0501' }).errors.contactPhone, 'too_short');
});

test('non-string input never crashes and is refused', () => {
  const { errors } = validateSubmission({ title: { $gt: '' }, companyName: ['a'], citySymbol: 'abc', jobScope: 'FullTime', requiredSkills: 'x' });
  for (const k of ['title', 'companyName', 'citySymbol', 'jobScope', 'requiredSkills', 'description', 'contactName', 'contactEmail', 'contactPhone', 'consent']) {
    assert.ok(errors[k], `${k} should be refused`);
  }
  assert.doesNotThrow(() => validateSubmission(null));
});

test('partial (staff edit) checks only the fields present and needs no consent', () => {
  const { value, errors } = validateSubmission({ title: 'כותרת חדשה' }, { partial: true });
  assert.deepEqual(errors, {});
  assert.deepEqual(Object.keys(value), ['title']);
});

test('honeypot', () => {
  assert.equal(isHoneypotHit({ ...ok, website: 'http://spam' }), true);
  assert.equal(isHoneypotHit({ ...ok, website: '' }), false);
  assert.equal(isHoneypotHit(ok), false);
});

test('description: markup is escaped, never rendered', () => {
  const html = descriptionToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)>\nשורה\n\nפסקה <a href="javascript:x">ק</a>');
  assert.ok(!/<(script|img|a)\b/i.test(html), html); // tags only as escaped text
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<br />') || html.includes('<br>'));
  assert.equal((html.match(/<p/g) || []).length, 2);
});

test('control and bidi-override characters are removed', () => {
  assert.equal(cleanText('a\u202Eb\u0000c'), 'abc');
  assert.equal(cleanReason('  '), null);
  assert.equal(cleanReason('x'.repeat(600)).length, 500);
});
