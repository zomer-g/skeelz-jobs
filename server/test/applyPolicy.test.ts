// Unit tests for the apply-policy logic (no DB, no server):
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkGuestApply,
  DEFAULT_APPLY_POLICY,
  normalizeApplyPolicy,
  resolveApplyPolicy,
} from '../src/models/schemas/applyPolicy.ts';

const ON = { quickApply: true, quickApplyWithoutCv: true };
const OFF = { quickApply: false, quickApplyWithoutCv: false };

test('defaults keep today\'s behaviour: quick apply on, CV optional', () => {
  assert.deepEqual({ ...DEFAULT_APPLY_POLICY }, { quickApply: true, quickApplyWithoutCv: true });
});

test('a job with no overrides inherits the defaults', () => {
  assert.deepEqual(resolveApplyPolicy({}, ON), ON);
  assert.deepEqual(resolveApplyPolicy({}, OFF), OFF);
  assert.deepEqual(resolveApplyPolicy({ quickApplyOverride: null, quickApplyWithoutCvOverride: null }, OFF), OFF);
});

test('an override wins over the default, in both directions, per setting', () => {
  assert.deepEqual(resolveApplyPolicy({ quickApplyOverride: false }, ON), { quickApply: false, quickApplyWithoutCv: true });
  assert.deepEqual(resolveApplyPolicy({ quickApplyOverride: true }, OFF), { quickApply: true, quickApplyWithoutCv: false });
  assert.deepEqual(resolveApplyPolicy({ quickApplyWithoutCvOverride: false }, ON), { quickApply: true, quickApplyWithoutCv: false });
  assert.deepEqual(resolveApplyPolicy({ quickApplyWithoutCvOverride: true }, OFF), { quickApply: false, quickApplyWithoutCv: true });
});

test('normalize ignores unknown or non-boolean fields and falls back per field', () => {
  assert.deepEqual(normalizeApplyPolicy(undefined), { ...DEFAULT_APPLY_POLICY });
  assert.deepEqual(normalizeApplyPolicy('junk'), { ...DEFAULT_APPLY_POLICY });
  assert.deepEqual(normalizeApplyPolicy({ quickApply: 'no', extra: 1 }, OFF), OFF);
  assert.deepEqual(normalizeApplyPolicy({ quickApplyWithoutCv: true }, OFF), { quickApply: false, quickApplyWithoutCv: true });
});

test('guest apply is refused when quick apply is off, with or without a CV', () => {
  assert.equal(checkGuestApply({ quickApply: false, quickApplyWithoutCv: true }, true), 'quick-apply-disabled');
  assert.equal(checkGuestApply({ quickApply: false, quickApplyWithoutCv: true }, false), 'quick-apply-disabled');
});

test('a missing CV is refused only when the policy requires one', () => {
  assert.equal(checkGuestApply({ quickApply: true, quickApplyWithoutCv: false }, false), 'cv-required');
  assert.equal(checkGuestApply({ quickApply: true, quickApplyWithoutCv: false }, true), null);
  assert.equal(checkGuestApply({ quickApply: true, quickApplyWithoutCv: true }, false), null);
  assert.equal(checkGuestApply(ON, true), null);
});
