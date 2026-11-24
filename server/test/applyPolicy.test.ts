// Unit tests for the apply-policy logic (no DB, no server): the three ways to apply and the CV rules.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGuestApply,
  checkRegularApply,
  DEFAULT_APPLY_POLICY,
  isValidOverride,
  isValidPolicyValue,
  legacyOverrides,
  normalizeApplyPolicy,
  publicApplyMode,
  resolveApplyPolicy,
  showsEmployerContact,
  type ApplyPolicy,
} from '../src/models/schemas/applyPolicy.ts';
import { stripManagedFields } from '../src/models/schemas/jobBoard.ts';

const QUICK: ApplyPolicy = { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' };
const STRICT: ApplyPolicy = { guestMode: 'none', quickCv: 'required', regularCv: 'required' };

test('default = today: guests quick-apply, no CV required anywhere', () => {
  assert.deepEqual({ ...DEFAULT_APPLY_POLICY }, QUICK);
});

test('no override (null / undefined) inherits every default', () => {
  assert.deepEqual(resolveApplyPolicy({}, STRICT), STRICT);
  assert.deepEqual(resolveApplyPolicy({ guestModeOverride: null, quickCvOverride: null, regularCvOverride: null }, QUICK), QUICK);
});

test('each override beats its default on its own', () => {
  assert.deepEqual(resolveApplyPolicy({ guestModeOverride: 'self' }, QUICK), { ...QUICK, guestMode: 'self' });
  assert.deepEqual(resolveApplyPolicy({ guestModeOverride: 'quick' }, STRICT), { ...STRICT, guestMode: 'quick' });
  assert.deepEqual(resolveApplyPolicy({ quickCvOverride: 'required' }, QUICK), { ...QUICK, quickCv: 'required' });
  assert.deepEqual(resolveApplyPolicy({ regularCvOverride: 'optional' }, STRICT), { ...STRICT, regularCv: 'optional' });
});

test('a bad stored override is ignored (falls back to the default)', () => {
  assert.deepEqual(resolveApplyPolicy({ guestModeOverride: 'open' as any, quickCvOverride: true as any }, STRICT), STRICT);
});

test('normalize: new shape, bad values fall back, old shape keeps its meaning', () => {
  assert.deepEqual(normalizeApplyPolicy({ guestMode: 'self', quickCv: 'x', extra: 1 }, STRICT), { ...STRICT, guestMode: 'self' });
  assert.deepEqual(normalizeApplyPolicy(null), QUICK);
  // Old settings row: { quickApply, quickApplyWithoutCv }
  assert.deepEqual(normalizeApplyPolicy({ quickApply: false, quickApplyWithoutCv: false }), { guestMode: 'none', quickCv: 'required', regularCv: 'optional' });
  assert.deepEqual(normalizeApplyPolicy({ quickApply: true, quickApplyWithoutCv: true }), QUICK);
});

test('old per-job columns map onto the new overrides', () => {
  assert.deepEqual(legacyOverrides({ is_self_apply: true, quick_apply_override: false }), { guestModeOverride: 'self', quickCvOverride: null, regularCvOverride: null });
  assert.deepEqual(legacyOverrides({ is_self_apply: false, quick_apply_override: true, quick_apply_without_cv_override: false }),
    { guestModeOverride: 'quick', quickCvOverride: 'required', regularCvOverride: null });
  assert.deepEqual(legacyOverrides({ is_self_apply: false, quick_apply_override: false, quick_apply_without_cv_override: true }),
    { guestModeOverride: 'none', quickCvOverride: 'optional', regularCvOverride: null });
  assert.deepEqual(legacyOverrides({}), { guestModeOverride: null, quickCvOverride: null, regularCvOverride: null });
});

test('guest mode self: the guest form is refused (apply with the employer directly)', () => {
  const p = { ...QUICK, guestMode: 'self' as const };
  assert.equal(checkGuestApply(p, true), 'self-apply-only');
  assert.equal(checkGuestApply(p, false), 'self-apply-only');
});

test('guest mode none: the guest form is refused (sign in to apply)', () => {
  assert.equal(checkGuestApply({ ...QUICK, guestMode: 'none' }, true), 'quick-apply-disabled');
});

test('guest mode quick: CV required refuses without one; optional accepts both', () => {
  assert.equal(checkGuestApply({ ...QUICK, quickCv: 'required' }, false), 'cv-required');
  assert.equal(checkGuestApply({ ...QUICK, quickCv: 'required' }, true), null);
  assert.equal(checkGuestApply(QUICK, false), null);
  assert.equal(checkGuestApply(QUICK, true), null);
});

test('regular apply is allowed in every guest mode', () => {
  for (const guestMode of ['self', 'quick', 'none'] as const) {
    assert.equal(checkRegularApply({ ...QUICK, guestMode }, false), null);
  }
});

test('regular apply, CV required: with a profile CV (or an upload) allowed, without any refused', () => {
  const p = { ...QUICK, regularCv: 'required' as const };
  assert.equal(checkRegularApply(p, true), null);
  assert.equal(checkRegularApply(p, false), 'cv-required');
  // The quick-apply CV rule does not affect regular applications, and vice versa.
  assert.equal(checkRegularApply({ ...QUICK, quickCv: 'required' }, false), null);
  assert.equal(checkGuestApply({ ...QUICK, regularCv: 'required' }, false), null);
});

test('the public sees only the effective mode; employer contact only on self-apply jobs', () => {
  assert.equal(publicApplyMode(resolveApplyPolicy({ guestModeOverride: 'self' }, STRICT)), 'self');
  assert.equal(publicApplyMode(STRICT), 'none');
  assert.equal(showsEmployerContact({ ...QUICK, guestMode: 'self' }), true);
  assert.equal(showsEmployerContact(QUICK), false);
  assert.equal(showsEmployerContact(STRICT), false);
});

test('validation of sent values', () => {
  assert.ok(isValidOverride('guestModeOverride', null));
  assert.ok(isValidOverride('guestModeOverride', 'self'));
  assert.ok(!isValidOverride('guestModeOverride', 'required'));
  assert.ok(isValidOverride('quickCvOverride', 'required'));
  assert.ok(!isValidOverride('regularCvOverride', true));
  assert.ok(isValidPolicyValue('guestMode', 'none'));
  assert.ok(!isValidPolicyValue('guestMode', null));
  assert.ok(!isValidPolicyValue('quickCv', 'self'));
});

test('integrations: once the screen set the guest mode, neither guestModeOverride nor isSelfApply gets through', () => {
  const r = stripManagedFields({ isSelfApply: true, guestModeOverride: 'quick', title: 'x' }, ['guestModeOverride']);
  assert.deepEqual(r.dto, { title: 'x' });
  assert.deepEqual(r.ignored.sort(), ['guestModeOverride', 'isSelfApply']);
  const free = stripManagedFields({ isSelfApply: true }, []);
  assert.deepEqual(free.dto, { isSelfApply: true });
});
