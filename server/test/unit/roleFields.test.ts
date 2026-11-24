// What a placement coordinator may change on a job (src/security/roleFields.ts; owner, 19.11.2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_MANAGER_FIELDS, restrictedChanges, thresholdNeedsContentManager } from '../../src/security/roleFields.js';
import { canManageContent, canViewStaffData, isStaffRole } from '../../src/models/enums.js';

const C = 'placement_coordinator';
const job = { title: 'x', thresholdCondition: 'תואר ראשון', guestModeOverride: null, quickCvOverride: 'required', regularCvOverride: null };

test('roles: a coordinator is staff and sees staff data, but does not manage content', () => {
  assert.equal(isStaffRole(C), true);
  assert.equal(canViewStaffData(C), true);
  assert.equal(canManageContent(C), false);
  for (const r of ['content_manager', 'admin']) assert.equal(canViewStaffData(r) && canManageContent(r), true);
  for (const r of ['user', 'employer', undefined, null, 'x']) assert.equal(canViewStaffData(r as any), false);
  assert.deepEqual([...CONTENT_MANAGER_FIELDS], ['thresholdCondition', 'guestModeOverride', 'quickCvOverride', 'regularCvOverride']);
});

test('content managers and admins: never restricted', () => {
  for (const r of ['content_manager', 'admin']) {
    assert.deepEqual(restrictedChanges(r, { thresholdCondition: 'חדש לגמרי', guestModeOverride: 'none' }, job), []);
    assert.deepEqual(restrictedChanges(r, { thresholdCondition: 'תנאי', quickCvOverride: 'optional' }, null), []);
  }
});

test('a coordinator: the same values sent back (the form sends every field) pass', () => {
  assert.deepEqual(restrictedChanges(C, { title: 'y', thresholdCondition: 'תואר ראשון', guestModeOverride: null,
    quickCvOverride: 'required', regularCvOverride: null }, job), []);
  assert.deepEqual(restrictedChanges(C, { thresholdCondition: '  תואר ראשון ' }, job), [], 'cleaned text is the same');
  assert.deepEqual(restrictedChanges(C, { title: 'only content' }, job), []);
});

test('a coordinator: a change of the condition or an apply setting is refused, by field name', () => {
  assert.deepEqual(restrictedChanges(C, { thresholdCondition: 'אחר' }, job), ['thresholdCondition']);
  assert.deepEqual(restrictedChanges(C, { thresholdCondition: '' }, job), ['thresholdCondition'], 'clearing is a change');
  assert.deepEqual(restrictedChanges(C, { thresholdCondition: null }, job), ['thresholdCondition']);
  assert.deepEqual(restrictedChanges(C, { guestModeOverride: 'quick', quickCvOverride: null }, job), ['guestModeOverride', 'quickCvOverride']);
  assert.deepEqual(restrictedChanges(C, { isSelfApply: true }, job), ['guestModeOverride'], 'legacy isSelfApply');
  assert.deepEqual(restrictedChanges(C, { isSelfApply: true }, { ...job, guestModeOverride: 'self' }), []);
});

test('a coordinator creating a job: defaults pass, a condition or an override is refused', () => {
  assert.deepEqual(restrictedChanges(C, { title: 'n', thresholdCondition: '', guestModeOverride: null, quickCvOverride: null, regularCvOverride: null }, null), []);
  assert.deepEqual(restrictedChanges(C, { title: 'n', thresholdCondition: 'רישיון נהיגה' }, null), ['thresholdCondition']);
  assert.deepEqual(restrictedChanges(C, { regularCvOverride: 'optional' }, null), ['regularCvOverride']);
});

test('employer submissions / edit requests with a threshold condition need a content manager', () => {
  assert.equal(thresholdNeedsContentManager(C, 'רישיון נהיגה'), true);
  assert.equal(thresholdNeedsContentManager(C, null), false);
  assert.equal(thresholdNeedsContentManager(C, '   '), false);
  assert.equal(thresholdNeedsContentManager('content_manager', 'רישיון נהיגה'), false);
  assert.equal(thresholdNeedsContentManager('admin', 'רישיון נהיגה'), false);
});
