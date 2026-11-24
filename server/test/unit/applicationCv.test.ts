// Unit tests for the CV-on-apply rules (no DB, no Salesforce).
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CvMode, CvScope, parseCvChoice, resolveApplicationCv, type CvDeps,
} from '../../src/services/applicationCv.js';

const PROFILE_KEY = 'post-scan/profile-token-1234/old_cv.pdf';
const NEW_KEY = 'post-scan/new-token-12345678/new_cv.pdf';

// Fake storage: only `pending` uploads can be claimed, and each only once.
const fakeDeps = (pending: string[] = ['new-token-12345678/new_cv.pdf']) => {
  const claims: Array<[string, string]> = [];
  const profileUpdates: Array<[string, string]> = [];
  const open = new Set(pending);
  const deps: CvDeps = {
    claimUpload: async (path, userId) => {
      if (!open.has(path)) return '';
      open.delete(path);
      claims.push([path, userId]);
      return `post-scan/${path}`;
    },
    setProfileCv: async (userId, key) => { profileUpdates.push([userId, key]); },
  };
  return { deps, claims, profileUpdates };
};

const user = { id: 'u1', cvFileUrl: PROFILE_KEY };

test('parseCvChoice: missing field means the profile CV (older clients)', () => {
  assert.deepEqual(parseCvChoice(undefined), { mode: CvMode.PROFILE });
  assert.deepEqual(parseCvChoice(null), { mode: CvMode.PROFILE });
  assert.deepEqual(parseCvChoice({ mode: 'profile', cvFilePath: 'ignored' }), { mode: CvMode.PROFILE });
});

test('parseCvChoice: upload modes need a file path; anything else is rejected', () => {
  assert.deepEqual(parseCvChoice({ mode: 'jobOnly', cvFilePath: 'a/b.pdf' }), { mode: CvMode.JOB_ONLY, cvFilePath: 'a/b.pdf' });
  assert.deepEqual(parseCvChoice({ mode: 'replaceProfile', cvFilePath: 'a/b.pdf' }), { mode: CvMode.REPLACE_PROFILE, cvFilePath: 'a/b.pdf' });
  for (const bad of ['profile', 42, { mode: 'jobOnly' }, { mode: 'jobOnly', cvFilePath: '' }, { mode: 'jobOnly', cvFilePath: 7 },
    { mode: 'replaceProfile', cvFilePath: 'x'.repeat(301) }, { mode: 'admin' }, {}]) {
    assert.throws(() => parseCvChoice(bad), (e: any) => e.code === 'jb12', JSON.stringify(bad));
  }
});

test('keep current CV: the profile CV is used and nothing is claimed or changed', async () => {
  const { deps, claims, profileUpdates } = fakeDeps();
  const r = await resolveApplicationCv({ mode: CvMode.PROFILE }, user, deps);
  assert.deepEqual(r, { cvFileUrl: PROFILE_KEY, cvScope: CvScope.PROFILE });
  assert.equal(claims.length, 0);
  assert.equal(profileUpdates.length, 0);
});

test('no CV on file + profile mode: applies without a CV', async () => {
  const { deps } = fakeDeps();
  const r = await resolveApplicationCv({ mode: CvMode.PROFILE }, { id: 'u2', cvFileUrl: '' }, deps);
  assert.deepEqual(r, { cvFileUrl: '', cvScope: CvScope.NONE });
});

test('replace profile CV: the upload is claimed by the user, becomes the profile CV and is used', async () => {
  const { deps, claims, profileUpdates } = fakeDeps();
  const r = await resolveApplicationCv({ mode: CvMode.REPLACE_PROFILE, cvFilePath: 'new-token-12345678/new_cv.pdf' }, user, deps);
  assert.deepEqual(r, { cvFileUrl: NEW_KEY, cvScope: CvScope.PROFILE, newProfileCvFileUrl: NEW_KEY });
  assert.deepEqual(claims, [['new-token-12345678/new_cv.pdf', 'u1']]);
  assert.deepEqual(profileUpdates, [['u1', NEW_KEY]]);
});

test('job-only CV: the upload is used for the application, the profile CV is untouched', async () => {
  const { deps, claims, profileUpdates } = fakeDeps();
  const r = await resolveApplicationCv({ mode: CvMode.JOB_ONLY, cvFilePath: 'new-token-12345678/new_cv.pdf' }, user, deps);
  assert.deepEqual(r, { cvFileUrl: NEW_KEY, cvScope: CvScope.JOB });
  assert.equal(r.newProfileCvFileUrl, undefined);
  assert.deepEqual(claims, [['new-token-12345678/new_cv.pdf', 'u1']]);
  assert.equal(profileUpdates.length, 0);
});

test('an upload that is not pending (someone else\'s, or already used) is refused and the profile is not changed', async () => {
  const { deps, profileUpdates } = fakeDeps([]);
  for (const mode of [CvMode.REPLACE_PROFILE, CvMode.JOB_ONLY] as const) {
    await assert.rejects(resolveApplicationCv({ mode, cvFilePath: 'other-token-1234/their_cv.pdf' }, user, deps), (e: any) => e.code === 'jb12');
  }
  assert.equal(profileUpdates.length, 0);
});

test('the same upload cannot be used twice', async () => {
  const { deps } = fakeDeps();
  const choice = { mode: CvMode.JOB_ONLY, cvFilePath: 'new-token-12345678/new_cv.pdf' } as const;
  await resolveApplicationCv(choice, user, deps);
  await assert.rejects(resolveApplicationCv(choice, { id: 'u3' }, deps));
});
