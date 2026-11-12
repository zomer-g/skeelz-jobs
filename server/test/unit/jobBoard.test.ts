// Board placement rules (src/models/schemas/jobBoard.ts): public order, visibility, publish date, integrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPublishDate, comparePublicOrder, isOpenByLink, isPubliclyListed, PUBLIC_LISTING_SQL, PUBLIC_ORDER_SQL,
  stripManagedFields,
} from '../../src/models/schemas/jobBoard.js';

const now = new Date('2026-11-12T10:00:00Z');
const day = 86_400_000;
const at = (ms: number) => new Date(now.getTime() + ms);

test('public order: pinned first (latest pin on top), then publish date newest first, then id', () => {
  const jobs = [
    { id: 'a', status: 'Active', publishDate: at(-1 * day) },
    { id: 'b', status: 'Active', publishDate: at(-10 * day), pinnedAt: at(-2 * day) },
    { id: 'c', status: 'Active', publishDate: at(-30 * day), pinnedAt: at(-1 * day) },
    { id: 'd', status: 'Active', publishDate: at(-5 * day) },
    { id: 'e', status: 'Active', publishDate: at(-5 * day) },
  ];
  assert.deepEqual([...jobs].sort(comparePublicOrder).map((j) => j.id), ['c', 'b', 'a', 'e', 'd']);
  assert.equal(PUBLIC_ORDER_SQL('j'), 'j.pinned_at DESC NULLS LAST, j.publish_date DESC, j.id DESC');
});

test('listed publicly = Active, public, not archived, published', () => {
  const base = { status: 'Active', isPublic: true, deletedAt: null, publishDate: at(-day) };
  assert.equal(isPubliclyListed(base, now), true);
  assert.equal(isPubliclyListed({ ...base, isPublic: false }, now), false);
  assert.equal(isPubliclyListed({ ...base, deletedAt: at(-1000) }, now), false);
  assert.equal(isPubliclyListed({ ...base, publishDate: at(day) }, now), false);
  for (const status of ['Suspended', 'Closed', 'active', '']) assert.equal(isPubliclyListed({ ...base, status }, now), false);
  assert.match(PUBLIC_LISTING_SQL('j'), /j\.status = 'Active' AND j\.is_public = true AND j\.deleted_at IS NULL AND j\.publish_date <= now\(\)/);
});

test('a private job still opens by direct link; archived and scheduled do not', () => {
  const base = { status: 'Active', isPublic: false, deletedAt: null, publishDate: at(-day) };
  assert.equal(isOpenByLink(base, now), true);
  assert.equal(isOpenByLink({ ...base, deletedAt: now }, now), false);
  assert.equal(isOpenByLink({ ...base, publishDate: at(day) }, now), false);
  assert.equal(isOpenByLink({ ...base, status: 'Closed' }, now), false);
});

test('publish date: past ok, future only as scheduled (max 365 days), rubbish refused', () => {
  assert.deepEqual(checkPublishDate(at(-day), now), { ok: true, date: at(-day), scheduled: false });
  assert.equal(checkPublishDate(at(5 * 60_000), now).ok, true, 'within the 10-minute grace');
  assert.deepEqual(checkPublishDate(at(day), now), { ok: false, code: 'future_needs_schedule' });
  assert.deepEqual(checkPublishDate(at(day), now, true), { ok: true, date: at(day), scheduled: true });
  assert.deepEqual(checkPublishDate(at(366 * day), now, true), { ok: false, code: 'too_far' });
  assert.deepEqual(checkPublishDate('2010-01-01', now), { ok: false, code: 'too_early' });
  for (const v of ['nope', '', null, undefined, {}]) assert.equal(checkPublishDate(v, now).ok, false);
  assert.equal(checkPublishDate(at(-day).toISOString(), now).ok, true);
});

test('integrations never change pin / visibility / archive, nor board fields set on the screen', () => {
  const dto = { title: 'x', isSponsored: true, publishDate: now, isPublic: false, pinnedAt: now, deletedAt: null };
  const r1 = stripManagedFields(dto, []);
  assert.deepEqual(Object.keys(r1.dto).sort(), ['isSponsored', 'publishDate', 'title']);
  assert.deepEqual(r1.ignored.sort(), ['deletedAt', 'isPublic', 'pinnedAt']);
  assert.deepEqual(stripManagedFields({ title: 'x', isPublic: undefined }, []), { dto: { title: 'x' }, ignored: [] }, 'undefined keys are not changes');
  const r2 = stripManagedFields(dto, ['isSponsored', 'publishDate', 'title']);
  assert.deepEqual(Object.keys(r2.dto), ['title'], 'only board fields can be owned by the screen');
});
