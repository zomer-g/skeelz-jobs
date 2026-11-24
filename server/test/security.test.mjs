// Unit tests for the pure security decisions (run: npx tsc && npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMITS, AUDIT_RETENTION_MONTHS, REVIEW, SUBMISSION_RETENTION_MONTHS, allowance, crossesAlert, countNewRows, capIds, israelDay, israelMidnight,
  reviewState, nextValidUntil, redactText, safeErrorText, isDbError, staffChangeRefusal, issuedBeforeRevoke, REVIEWED_ROLES,
  EMPLOYER_ACCESS_DAYS, SIGNIN_ALERTS, employerWindowOpen, employerAccessUntil, forwardCancelRefusal, BUDGET_ACTIONS, GRANTABLE_BUDGETS, SEEN_ACTIONS,
} from '../dist/security/pure.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('allowance cuts to what is left and is never negative', () => {
  assert.equal(allowance(0, 40, 5), 5);
  assert.equal(allowance(38, 40, 5), 2);
  assert.equal(allowance(40, 40, 5), 0);
  assert.equal(allowance(45, 40, 5), 0);
  assert.equal(allowance(10, 40, -3), 0);
});

test('crossesAlert fires exactly once, when crossing', () => {
  assert.equal(crossesAlert(18, 1, 20), false);
  assert.equal(crossesAlert(19, 1, 20), true);
  assert.equal(crossesAlert(20, 1, 20), false);
  assert.equal(crossesAlert(10, 15, 20), true);
  assert.equal(crossesAlert(10, 0, 20), false);
});

test('countNewRows counts each person once a day', () => {
  assert.equal(countNewRows(['a', 'b', 'c'], []), 3);
  assert.equal(countNewRows(['a', 'b', 'a'], []), 2);
  assert.equal(countNewRows(['a', 'b', 'c'], ['b']), 2);
  assert.equal(countNewRows(['a', ''], new Set(['a'])), 0);
});

test('capIds dedupes, caps and flags', () => {
  assert.deepEqual(capIds(['a', 'a', 'b']), { ids: ['a', 'b'] });
  const big = capIds(Array.from({ length: 1005 }, (_, i) => `id${i}`));
  assert.equal(big.ids.length, 1000);
  assert.equal(big.more_ids, true);
});

test('Israel day and midnight (winter and summer time)', () => {
  // 23:30 UTC on 10 Nov = 01:30 on 11 Nov in Israel (UTC+2).
  assert.equal(israelDay(new Date('2026-11-10T23:30:00Z')), '2026-11-11');
  assert.equal(israelMidnight('2026-11-11').toISOString(), '2026-11-10T22:00:00.000Z');
  // Summer (UTC+3).
  assert.equal(israelMidnight('2026-07-01').toISOString(), '2026-06-30T21:00:00.000Z');
  assert.equal(israelDay(new Date('2026-06-30T21:30:00Z')), '2026-07-01');
});

test('access review states and renewal from the end of the period', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const day = 86400_000;
  assert.equal(reviewState(null, 'admin', now), 'never');
  assert.equal(reviewState({ validUntil: new Date(now.getTime() + 30 * day), roleAtReview: 'admin' }, 'admin', now), 'valid');
  assert.equal(reviewState({ validUntil: new Date(now.getTime() + 5 * day), roleAtReview: 'admin' }, 'admin', now), 'due_soon');
  assert.equal(reviewState({ validUntil: new Date(now.getTime() - day), roleAtReview: 'admin' }, 'admin', now), 'expired');
  assert.equal(reviewState({ validUntil: new Date(now.getTime() + 30 * day), roleAtReview: 'user' }, 'admin', now), 'changed');
  const end = new Date(now.getTime() + 5 * day);
  assert.equal(nextValidUntil(end, now).getTime(), end.getTime() + REVIEW.validDays * day);
  assert.equal(nextValidUntil(null, now).getTime(), now.getTime() + REVIEW.validDays * day);
  assert.equal(nextValidUntil(new Date(now.getTime() - day), now).getTime(), now.getTime() + REVIEW.validDays * day);
});

test('redaction: emails, phones, DB errors, third-party bodies', () => {
  assert.equal(redactText('user dana.k@example.co.il called 050-1234567'), 'user [email] called [phone]');
  assert.equal(redactText('tel +972 52 123 4567.'), 'tel [phone].');
  const dbErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505', severity: 'ERROR', detail: 'Key (email)=(dana@example.com) already exists.' });
  assert.equal(isDbError(dbErr), true);
  assert.equal(safeErrorText(dbErr), 'database error (23505)');
  const ax = { isAxiosError: true, message: 'Request failed with status code 400', code: 'ERR_BAD_REQUEST',
    response: { status: 400, data: { message: 'duplicate contact dana@example.com' } } };
  assert.equal(safeErrorText(ax), 'http error 400 (ERR_BAD_REQUEST): Request failed with status code 400');
  assert.ok(!safeErrorText(ax).includes('dana'));
});

test('staff changes: no lock-out, no self-deactivation, known roles only', () => {
  const t = (role, active = true, id = 't') => ({ id, role, active });
  const r = (target, change, activeAdmins, actorId = 'me') => staffChangeRefusal({ actorId, target, change, activeAdmins });
  // the last active admin can't be demoted or deactivated — also not by themself
  assert.equal(r(t('admin'), { kind: 'role', to: 'content_manager' }, 1), 'last_admin');
  assert.equal(r(t('admin', true, 'me'), { kind: 'role', to: 'user' }, 1), 'last_admin');
  assert.equal(r(t('admin'), { kind: 'deactivate' }, 1), 'last_admin');
  // with another active admin it is allowed (including demoting yourself)
  assert.equal(r(t('admin', true, 'me'), { kind: 'role', to: 'content_manager' }, 2), null);
  assert.equal(r(t('admin'), { kind: 'deactivate' }, 2), null);
  // a deactivated admin is not counted as "the last one"
  assert.equal(r(t('admin', false), { kind: 'role', to: 'user' }, 1), null);
  // nobody deactivates themself
  assert.equal(r(t('content_manager', true, 'me'), { kind: 'deactivate' }, 3), 'self_deactivate');
  assert.equal(r(t('content_manager', false), { kind: 'deactivate' }, 3), 'no_change');
  // roles
  assert.equal(r(t('user'), { kind: 'role', to: 'superuser' }, 1), 'bad_role');
  assert.equal(r(t('user'), { kind: 'role', to: 'content_manager' }, 1), null);
  assert.equal(r(t('content_manager'), { kind: 'role', to: 'content_manager' }, 1), 'no_change');
  assert.equal(r(t('user'), { kind: 'role', to: 'placement_coordinator' }, 1), null);
  assert.equal(r(t('placement_coordinator'), { kind: 'role', to: 'content_manager' }, 1), null);
  assert.deepEqual([...REVIEWED_ROLES].sort(), ['admin', 'content_manager', 'placement_coordinator']);
});

test('revoke sessions refuses access tokens issued up to that second', () => {
  const at = new Date('2026-11-11T10:00:00.500Z');
  const sec = Math.floor(at.getTime() / 1000);
  assert.equal(issuedBeforeRevoke(sec - 60, at), true);
  assert.equal(issuedBeforeRevoke(sec, at), true);
  assert.equal(issuedBeforeRevoke(sec + 1, at), false);
  assert.equal(issuedBeforeRevoke(undefined, at), true);
  assert.equal(issuedBeforeRevoke(sec - 60, null), false);
});

test('the DB trigger keeps the activity log for AUDIT_RETENTION_MONTHS', () => {
  // The DB trigger hard-codes the retention too.
  const db = fs.readFileSync(path.join(here, '..', 'src', 'config', 'db.ts'), 'utf8');
  assert.ok(db.includes(`make_interval(months => ${AUDIT_RETENTION_MONTHS})`), 'trigger retention differs from AUDIT_RETENTION_MONTHS');
});

// ---- applicants forwarded to employers (docs/employers.md "Applicants") ----
test('employer access window: open while active, closes EMPLOYER_ACCESS_DAYS after the job stopped being active', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  const days = (n) => new Date(now.getTime() - n * 86400_000);
  assert.equal(EMPLOYER_ACCESS_DAYS, 90);
  assert.equal(employerWindowOpen({ status: 'Active', deletedAt: null }, null, now), true);
  assert.equal(employerWindowOpen({ status: 'Active', deletedAt: null }, days(400), now), true, 'active again: no end');
  assert.equal(employerAccessUntil({ status: 'Active' }, days(5)), null);
  for (const j of [{ status: 'Closed' }, { status: 'Suspended' }, { status: 'Active', deletedAt: days(1) }]) {
    assert.equal(employerWindowOpen(j, days(89), now), true, `${j.status} 89 days`);
    assert.equal(employerWindowOpen(j, days(91), now), false, `${j.status} 91 days`);
    assert.equal(employerWindowOpen(j, null, now), false, 'not active and no moment → closed');
  }
  assert.equal(employerAccessUntil({ status: 'Closed' }, days(10)).getTime(), days(10).getTime() + 90 * 86400_000);
});

test('a forward can be cancelled only while live and unseen', () => {
  assert.equal(forwardCancelRefusal(null), 'forward_not_found');
  assert.equal(forwardCancelRefusal({ cancelledAt: null, firstSeenAt: null }), null);
  assert.equal(forwardCancelRefusal({ cancelledAt: null, firstSeenAt: new Date() }), 'forward_seen');
  assert.equal(forwardCancelRefusal({ cancelledAt: new Date(), firstSeenAt: null }), 'forward_cancelled');
});

test('employers have their own budgets and actions, never raised, never shared with staff', () => {
  assert.deepEqual(LIMITS.employerPeople, { daily: 200, alertAt: 100, grant: 0 });
  assert.deepEqual(LIMITS.employerCvs, { daily: 30, alertAt: 15, grant: 0 });
  assert.deepEqual([...GRANTABLE_BUDGETS].sort(), ['cvs', 'people']);
  const staff = [...BUDGET_ACTIONS.cvs, ...BUDGET_ACTIONS.people];
  for (const a of [...BUDGET_ACTIONS.employerCvs, ...BUDGET_ACTIONS.employerPeople]) {
    assert.ok(a.startsWith('employer.') && !staff.includes(a), a);
    assert.ok(SEEN_ACTIONS.includes(a), `${a} marks people as seen`);
  }
});
