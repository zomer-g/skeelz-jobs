// security/consent.ts: the required terms box, the optional marketing box, and the mailing-list gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkConsent, applyConsent, mayAddToMailingList, needsTerms, needsMarketingAnswer, TERMS_VERSION, MARKETING_REQUIRED,
} from '../../src/security/consent.ts';

const form = { needTerms: true, askMarketing: true };

test('the terms box is required and only the literal true counts', () => {
  for (const consent of [undefined, false, 'true', 1, 'on', null]) {
    const c = checkConsent({ consent }, form);
    assert.equal(c.ok, false, String(consent));
    assert.equal(c.error, 'terms_required');
  }
  assert.equal(checkConsent({ consent: true }, form).ok, true);
  assert.equal(checkConsent(null, form).error, 'terms_required');
});

test('the marketing box is optional, unticked by default, and must be a boolean when sent', () => {
  assert.equal(MARKETING_REQUIRED, false, 'marketing must stay optional unless the owner decides otherwise');
  assert.deepEqual(checkConsent({ consent: true }, form).value, { terms: true, marketing: false });
  assert.deepEqual(checkConsent({ consent: true, marketingConsent: true }, form).value, { terms: true, marketing: true });
  assert.deepEqual(checkConsent({ consent: true, marketingConsent: false }, form).value, { terms: true, marketing: false });
  assert.equal(checkConsent({ consent: true, marketingConsent: 'yes' }, form).error, 'marketing_invalid');
});

test('registered apply: terms asked only for a new version, marketing only if never answered', () => {
  const fresh = { termsVersion: null, marketingConsent: null };
  assert.deepEqual(applyConsent(fresh, {}), { needTerms: true, needMarketing: true, missing: true, record: {} });
  assert.deepEqual(applyConsent(fresh, { consent: true }).missing, true, 'marketing must be answered (true or false)');
  assert.deepEqual(applyConsent(fresh, { consent: true, marketingConsent: false }), {
    needTerms: true, needMarketing: true, missing: false, record: { terms: true, marketing: false },
  });
  const old = { termsVersion: '2020-01-01', marketingConsent: true };
  assert.deepEqual(applyConsent(old, {}), { needTerms: true, needMarketing: false, missing: true, record: {} });
  assert.deepEqual(applyConsent(old, { consent: true, marketingConsent: false }).record, { terms: true }, 'an answered marketing box is not overwritten from apply');
  const done = { termsVersion: TERMS_VERSION, marketingConsent: false };
  assert.deepEqual(applyConsent(done, {}), { needTerms: false, needMarketing: false, missing: false, record: {} });
  assert.equal(needsTerms(done), false);
  assert.equal(needsMarketingAnswer({ termsVersion: TERMS_VERSION, marketingConsent: null }), true);
});

test('only an explicit yes reaches the mailing list', () => {
  assert.equal(mayAddToMailingList(true), true);
  for (const v of [false, null, undefined]) assert.equal(mayAddToMailingList(v), false);
});

test('the mailing list is reached only through the consent gate', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', f), 'utf8');
  const userService = src('services/userService.ts');
  const guest = src('services/jobApplicationService.ts');
  assert.match(userService, /if \(mayAddToMailingList\(opts\.consent\.marketing\)\) \{[\s\S]{0,200}createSmooveContact/);
  assert.match(guest, /enableSmoove && mayAddToMailingList\(consent\.marketing\)\) \{\s*await smooveService\.ensureSmooveGuest/);
  // No other caller of the SMOOV service.
  for (const f of fs.readdirSync(path.join(import.meta.dirname, '..', '..', 'src'), { recursive: true }) as string[]) {
    if (!f.endsWith('.ts') || /smooveService\.ts$/.test(f)) continue;
    const s = src(f);
    const calls = s.match(/smooveService\.\w+\(/g) ?? [];
    if (calls.length) assert.ok(/userService\.ts$|jobApplicationService\.ts$/.test(f), `${f} calls SMOOV: ${calls.join(', ')}`);
  }
});
