// Unit tests for the low-severity fixes of the security review of 24.11.2026 (pure parts; the DB parts are in
// e2e-multi-role (L3), e2e-settings (L4, L5) and e2e-consent (L6)).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ACCESS_TOKEN_SECRET ||= 'unit-test-secret-0123456789abcdef0123';
process.env.REFRESH_TOKEN_SECRET ||= 'unit-test-secret-0123456789abcdef0123';
process.env.RESET_TOKEN_SECRET ||= 'unit-test-secret-0123456789abcdef0123';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1:1/none'; // never connected here

const { unverifiedName, unverifiedAllowed } = await import('../../src/mail/triggers.js');
const { employerFacing } = await import('../../src/services/customFieldsService.js');

test('L9: an unverified name is one plain word, never a link or an address', () => {
  assert.equal(unverifiedName('דנה כהן'), 'דנה');
  assert.equal(unverifiedName('  Dana  '), 'Dana');
  for (const bad of ['evil.example', 'https://x', 'www', 'a@b', '<b>', 'x'.repeat(31), '', 'a/b']) assert.equal(unverifiedName(bad), '', bad);
  assert.equal(unverifiedName('א'.repeat(2000)), '');
});

test('L9: an unverified address gets a few such emails a day, counted by address (case-insensitive)', () => {
  const day = new Date('2026-11-24T10:00:00Z');
  const to = `limit-${Date.now()}@example.test`;
  const sent = Array.from({ length: 8 }, () => unverifiedAllowed(to, day));
  assert.ok(sent.filter(Boolean).length >= 1 && sent.filter(Boolean).length < 8);
  assert.equal(unverifiedAllowed(to.toUpperCase(), day), false, 'the same address in capitals');
  assert.equal(unverifiedAllowed(to, new Date('2026-11-25T10:00:00Z')), true, 'a new day');
  assert.equal(unverifiedAllowed(`other-${to}`, day), true, 'another address');
});

test('L5: the anonymous employer form gets only the fields the job page shows; employers and staff get all', () => {
  const d = (id: string, showOnJobPage: boolean) => ({ id, form: 'job', label: id, type: 'text', options: [], required: false,
    sortOrder: 1, active: true, showOnJobPage, help: '', sfField: null }) as any;
  const defs = [d('shown', true), d('staff', false)];
  assert.deepEqual(employerFacing(defs, null).map((x) => x.id), ['shown']);
  assert.deepEqual(employerFacing(defs, { roles: ['user'] }).map((x) => x.id), ['shown']);
  assert.deepEqual(employerFacing(defs, { roles: ['employer'] }).map((x) => x.id), ['shown', 'staff']);
  assert.deepEqual(employerFacing(defs, { roles: ['placement_coordinator'] }).map((x) => x.id), ['shown', 'staff']);
  assert.deepEqual(employerFacing(defs, { roles: ['user', 'admin'] }).map((x) => x.id), ['shown', 'staff']);
});
