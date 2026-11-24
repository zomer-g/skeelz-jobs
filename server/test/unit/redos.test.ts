// Security review 24.11.2026, H1: no user text runs a quadratic regex. A tag stripper written `/<[^>]*>/` takes
// seconds to minutes on "<<<<…" (one request blocked the single Node process). Each case below must finish fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCustomValues, plainLine, CUSTOM_FIELD_RAW_MAX, CUSTOM_FIELD_LIMITS } from '../../src/models/schemas/customFields.ts';
import { htmlToPlainText } from '../../src/security/employer.ts';
import { checkThresholdCondition } from '../../src/models/schemas/thresholdCondition.ts';

const def = { id: 'f1', form: 'job', label: 'שאלה', type: 'text', options: [], required: false, sortOrder: 10, active: true,
  showOnJobPage: true, help: '', sfField: null } as const;
const BIG = '<'.repeat(1_000_000); // about the body limit
const fast = (name: string, fn: () => unknown, ms = 300) => {
  const t = performance.now();
  fn();
  const took = performance.now() - t;
  assert.ok(took < ms, `${name}: ${Math.round(took)} ms`);
};

test('a huge "<<<…" answer is refused by its size before any cleaning, at once', () => {
  let r: any;
  fast('checkCustomValues', () => { r = checkCustomValues([def as any], { f1: BIG }); });
  assert.equal(r.ok, false);
  assert.deepEqual(r.bad, ['f1']);
  assert.equal(CUSTOM_FIELD_RAW_MAX, CUSTOM_FIELD_LIMITS.text.max * 2);
  // Just over the raw limit is refused; a legit answer with a few tags still passes.
  assert.equal(checkCustomValues([def as any], { f1: 'א'.repeat(CUSTOM_FIELD_RAW_MAX + 1) }).ok, false);
  const ok = checkCustomValues([def as any], { f1: '<b>שכר</b> 12,000 ₪' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.values.f1, 'שכר 12,000 ₪');
});

test('every tag stripper on user text is linear', () => {
  fast('plainLine', () => plainLine(BIG));
  fast('plainLine mixed', () => plainLine('<a'.repeat(300_000)));
  fast('htmlToPlainText', () => htmlToPlainText(BIG));
  fast('htmlToPlainText <li', () => htmlToPlainText('<li'.repeat(300_000)));
  fast('threshold condition', () => checkThresholdCondition(BIG));
  assert.equal(plainLine('<b>כן</b> <i>לא</i>'), 'כן לא');
});
