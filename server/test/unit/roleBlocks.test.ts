// Per-role blocks (owner, 24.11.2026): the pure rules. End-to-end: test/e2e-role-blocks.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKABLE_ROLES, blockKeyOf, blockableRolesHeld, blockedOf, usableRolesOf } from '../../src/models/enums.ts';
import { effectiveRoles, SIGNIN_FAILURE_ACTIONS } from '../../src/security/pure.ts';
import { sendRefusal } from '../../src/security/emailCode.ts';
import { isStaffRole } from '../../src/security/pure.ts';

test('three kinds of role can be blocked: candidate, employer, staff (any staff role)', () => {
  assert.deepEqual([...BLOCKABLE_ROLES], ['user', 'employer', 'staff']);
  assert.equal(blockKeyOf('user'), 'user');
  assert.equal(blockKeyOf('employer'), 'employer');
  for (const r of ['admin', 'content_manager', 'placement_coordinator']) assert.equal(blockKeyOf(r), 'staff');
});

test('a blocked role counts for nothing; the others stay', () => {
  const all = { roles: ['user', 'employer', 'content_manager'] };
  assert.deepEqual(usableRolesOf({ ...all, blockedRoles: ['employer'] }).sort(), ['content_manager', 'user']);
  assert.deepEqual(usableRolesOf({ ...all, blocked_roles: ['staff'] }).sort(), ['employer', 'user']);
  assert.deepEqual(usableRolesOf({ ...all, blocked_roles: ['user', 'employer', 'staff'] }), []);
  assert.deepEqual(usableRolesOf(all).sort(), ['content_manager', 'employer', 'user']);
  // Unknown block names are ignored, never widen anything.
  assert.deepEqual(blockedOf({ blocked_roles: ['admin', 'x', 'user'] }), ['user']);
  assert.deepEqual(blockableRolesHeld({ roles: ['admin', 'user'] }), ['user', 'staff']);
});

test('the sign-in method still applies after the blocks (staff only on Google)', () => {
  const u = { roles: ['user', 'admin'], blockedRoles: ['user'] };
  assert.deepEqual(effectiveRoles(usableRolesOf(u), 'email_code'), []); // nothing left for a code → no session
  assert.deepEqual(effectiveRoles(usableRolesOf(u), 'xhostd'), ['admin']);
  assert.deepEqual(effectiveRoles(usableRolesOf({ roles: ['employer', 'admin'], blockedRoles: ['staff'] }), 'xhostd'), ['employer']);
});

test('no code is sent when every role a code may carry is blocked; refusals are counted', () => {
  assert.equal(sendRefusal({ roles: ['user'], blocked: true }, isStaffRole), 'blocked');
  assert.equal(sendRefusal({ roles: ['admin'], blocked: true }, isStaffRole), 'staff'); // staff-only: as before
  assert.equal(sendRefusal({ roles: ['user'], deactivated: true, blocked: true }, isStaffRole), 'deactivated');
  assert.equal(sendRefusal({ roles: ['user', 'employer'], blocked: false }, isStaffRole), null);
  for (const a of ['auth.login_refused_blocked', 'auth.email_code_refused_blocked']) assert.ok(SIGNIN_FAILURE_ACTIONS.includes(a), a);
});
