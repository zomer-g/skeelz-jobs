// Analytics must never carry personal data to Google.
// Tests the pure allowlist the client uses for every event (client/src/utils/analyticsPolicy.ts)
// and that docs / server / client agree on the event list and consent storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEvent, EVENTS, PARAM_CHECKS, KEY_EVENTS, sanitizeUrl, sanitizePath, sanitizeReferrer,
  utmFrom, errorCodeFrom, parseConsent, consentModeState, CONSENT_STORAGE_KEY, CONSENT_MAX_AGE_DAYS,
  GA_COOKIE_EXPIRES_SECONDS, GA_COOKIE_MONTHS, GA_RETENTION_MONTHS, GA_COOKIE_NAME, CONTEXT_KEYS,
} from '../../client/src/utils/analyticsPolicy.ts';
import { EVENT_LABELS, PARAM_LABELS } from '../../client/src/components/privacy/analyticsDisclosure.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

const JOB = '0123456789abcdef01234567';
const PERSONAL = {
  email: 'dana.cohen@example.com',
  name: 'דנה כהן',
  phone: '0521234567',
  phoneIntl: '+972-52-123-4567',
  cvFile: 'Dana_Cohen_CV.pdf',
  freeText: 'מחפשת עבודה בתל אביב',
};

test('unknown events are dropped', () => {
  assert.equal(buildEvent('purchase', { value: 1 }), null);
  assert.equal(buildEvent('user_details', {}), null);
});

test('unknown keys are dropped, even with harmless values', () => {
  const ev = buildEvent('apply_click', { job_id: JOB, email: PERSONAL.email, fullName: PERSONAL.name, phoneNumber: PERSONAL.phone, cvFileName: PERSONAL.cvFile, search: PERSONAL.freeText, apply_type: 'guest' } as any);
  assert.deepEqual(ev, { event: 'apply_click', job_id: JOB, apply_type: 'guest' });
});

test('a key allowed on one event is not allowed on another', () => {
  assert.deepEqual(buildEvent('job_list_view', { job_id: JOB, field_name: 'email' }), { event: 'job_list_view' });
});

test('personal values are rejected in every allowed key', () => {
  for (const [name, keys] of Object.entries(EVENTS)) {
    for (const key of keys) {
      for (const value of Object.values(PERSONAL)) {
        const ev = buildEvent(name, { [key]: value });
        assert.ok(ev, name);
        assert.equal(ev![key], undefined, `${name}.${key} accepted "${value}"`);
      }
    }
  }
  for (const key of ['page_path', 'page_location', 'page_referrer', 'utm_source', 'utm_campaign', 'utm_content', 'utm_term', 'utm_medium']) {
    for (const [kind, value] of Object.entries(PERSONAL)) {
      // A UTM value is a label marketing chose; a plain ASCII token cannot be told from a campaign name by
      // its shape, so docs/analytics.md forbids merge tags (names etc.) in UTMs. Emails, phones, Hebrew
      // and spaced text are still dropped.
      if (kind === 'cvFile' && key.startsWith('utm_')) continue;
      assert.equal(buildEvent('page_view', { [key]: value })![key], undefined, `${key} accepted "${value}"`);
    }
  }
});

test('emails inside utm or url values are rejected', () => {
  assert.equal(buildEvent('page_view', { utm_content: 'dana@example.com' })!.utm_content, undefined);
  assert.equal(buildEvent('page_view', { page_location: 'https://jobs.skeelz.co.il/?e=dana@example.com' })!.page_location, undefined);
  assert.equal(buildEvent('page_view', { utm_campaign: 'newsletter_nov' })!.utm_campaign, 'newsletter_nov');
});

test('enums and numbers are type-checked', () => {
  assert.deepEqual(buildEvent('apply_form_shown', { apply_type: 'vip', cv_required: 'yes' as any, job_id: JOB }), { event: 'apply_form_shown', job_id: JOB });
  assert.deepEqual(buildEvent('map_search', { radius_km: 25, results_count: 3, map_point_source: 'geo' }), { event: 'map_search', radius_km: 25, results_count: 3, map_point_source: 'geo' });
  // coordinates are not integers in range and have no key anyway
  assert.equal(buildEvent('map_search', { radius_km: 32.0853 })!.radius_km, undefined);
  assert.equal(buildEvent('map_search', { lat: 32.08, lng: 34.78 } as any)!.lat, undefined);
});

test('every event key has a value check, and no key is named like personal data', () => {
  const banned = /(email|mail|phone|name|first|last|address|cv_file|file_name|text|query|search_term|lat|lng|coord|token|password|ip)/i;
  for (const [name, keys] of Object.entries(EVENTS)) {
    for (const key of keys) {
      assert.ok(PARAM_CHECKS[key], `${name}.${key} has no check`);
      if (key !== 'field_name' && key !== 'has_search_text' && key !== 'step_name') assert.doesNotMatch(key, banned, `${name}.${key}`);
    }
  }
  for (const k of KEY_EVENTS) assert.ok(EVENTS[k], k);
});

test('field_name carries a field name, never a value', () => {
  assert.equal(buildEvent('apply_validation_error', { field_name: 'phoneNumber' })!.field_name, 'phoneNumber');
  assert.equal(buildEvent('apply_validation_error', { field_name: '0521234567' })!.field_name, undefined);
  assert.equal(buildEvent('post_job_validation_error', { field_name: 'contact email' })!.field_name, undefined);
});

test('URLs keep only path + utm/view; tokens, search text and odd segments are removed', () => {
  assert.equal(
    sanitizeUrl('https://jobs.skeelz.co.il/?searchValue=%D7%93%D7%A0%D7%94&utm_source=smoov&utm_campaign=nov_2026&view=map&scope=1'),
    'https://jobs.skeelz.co.il/?utm_source=smoov&utm_campaign=nov_2026&view=map');
  assert.equal(sanitizeUrl('https://jobs.skeelz.co.il/reset-password?token=eyJhbGciOi.abc.def'), 'https://jobs.skeelz.co.il/reset-password');
  assert.equal(sanitizeUrl('https://jobs.skeelz.co.il/job/0123456789abcdef01234567?x=1'), 'https://jobs.skeelz.co.il/job/0123456789abcdef01234567');
  assert.equal(sanitizePath('/job/dana@example.com'), '/job/:redacted');
  assert.equal(sanitizePath('/job/0521234567'), '/job/:redacted');
  assert.equal(sanitizeUrl('https://jobs.skeelz.co.il/?utm_content=dana@example.com'), 'https://jobs.skeelz.co.il/');
  assert.equal(sanitizeReferrer('https://mail.example.com/inbox?u=dana@example.com'), 'https://mail.example.com/');
  assert.deepEqual(utmFrom('?utm_source=facebook&utm_term=0521234567&utm_medium=cpc'), { utm_source: 'facebook', utm_medium: 'cpc' });
});

test('error codes are enum keys, never the message or other text', () => {
  const dicts = [{ USER_ALREADY_EXISTS: 'המשתמש כבר קיים' }, { JOB_NOT_FOUND: 'Job not found' }];
  assert.equal(errorCodeFrom('Job not found', dicts), 'JOB_NOT_FOUND');
  assert.equal(errorCodeFrom('dana@example.com is not valid', dicts), 'UNKNOWN');
});

test('consent: parsed strictly, expires, ads never granted', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  assert.deepEqual(parseConsent(JSON.stringify({ analytics: true, at: '2026-10-01T00:00:00Z' }), now), { analytics: true, at: '2026-10-01T00:00:00Z' });
  assert.equal(parseConsent(JSON.stringify({ analytics: true, at: '2025-01-01T00:00:00Z' }), now), null);
  assert.equal(parseConsent('garbage', now), null);
  assert.equal(parseConsent(JSON.stringify({ analytics: 'yes', at: '2026-10-01' }), now), null);
  const s = consentModeState(true);
  assert.equal(s.analytics_storage, 'granted');
  assert.equal(s.ad_storage, 'denied');
  assert.equal(s.ad_user_data, 'denied');
  assert.equal(s.ad_personalization, 'denied');
});

test('server consent default matches the client (key, max age, default denied)', () => {
  const src = read('server', 'src', 'index.ts');
  assert.match(src, new RegExp(`localStorage.getItem\\('${CONSENT_STORAGE_KEY}'\\)`));
  assert.match(src, new RegExp(`${CONSENT_MAX_AGE_DAYS}\\*864e5`));
  assert.match(src, /gtag\('consent','default',\{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'/);
  assert.match(src, /send_page_view:false/);
  // Nothing from Google loads before consent: gtm.js / gtag.js are injected only inside
  // window.__skeelzLoadAnalytics, which runs inline only for a stored accept (else the banner calls it).
  const fn = src.slice(src.indexOf('const analyticsSnippet'), src.indexOf('const contentSecurityPolicy'));
  assert.doesNotMatch(fn, /<script[^>]*src=/, 'a Google script tag is written into the HTML before consent');
  const ret = fn.slice(fn.indexOf('return `<script'));
  assert.ok(ret.indexOf("gtag('consent','default'") < ret.indexOf('window.__skeelzLoadAnalytics=function'), 'consent default must come first');
  assert.match(ret, /analytics===true[^}]*\{gtag\('consent','update',\{analytics_storage:'granted'\}\);window\.__skeelzLoadAnalytics\(\);\}/);
  assert.equal((ret.match(/__skeelzLoadAnalytics\(\)/g) || []).length, 1, 'loader is called inline only for a stored accept');
  assert.match(src, new RegExp(`GA_COOKIE_EXPIRES_SECONDS = ${GA_COOKIE_EXPIRES_SECONDS};`));
  // client side: the loader is called only when accepting
  const client = read('client', 'src', 'utils', 'analytics.ts');
  const setConsent = client.slice(client.indexOf('export function setConsent'), client.indexOf('/** Withdrawal'));
  assert.match(setConsent, /if \(analytics\) \{[\s\S]*?__skeelzLoadAnalytics\?\.\(\)[\s\S]*?\} else \{/);
  assert.match(setConsent, /else \{\s*deleteGaCookies\(\);/);
});

test('the privacy page states the consent period and names Google', () => {
  const src = read('client', 'src', 'components', 'privacy', 'PrivacyPage.tsx');
  const m = src.match(/PRIVACY_CONSENT_MONTHS = (\d+)/);
  assert.ok(m, 'PRIVACY_CONSENT_MONTHS not found');
  assert.equal(Number(m![1]) * 30 + 5, CONSENT_MAX_AGE_DAYS, 'privacy page months ≠ CONSENT_MAX_AGE_DAYS');
  assert.match(src, /Google Analytics/);
  assert.match(read('docs', 'privacy', 'database-definition.md'), /Google \(Google Analytics 4 דרך Google Tag Manager\)/);
});

test('privacy texts list exactly the allowlisted events and parameters (like PRIVACY_NUMBERS)', () => {
  // Every event / parameter that can be sent has a Hebrew label, and no label is left for one that can't.
  assert.deepEqual(Object.keys(EVENT_LABELS).sort(), Object.keys(EVENTS).sort(), 'EVENT_LABELS ≠ EVENTS');
  assert.deepEqual(Object.keys(PARAM_LABELS).sort(), Object.keys(PARAM_CHECKS).sort(), 'PARAM_LABELS ≠ PARAM_CHECKS');
  for (const [k, v] of Object.entries({ ...EVENT_LABELS, ...PARAM_LABELS })) assert.ok(v.trim().length > 2, k);
  // The page builds its table from the allowlist itself (not a copy).
  const page = read('client', 'src', 'components', 'privacy', 'PrivacyPage.tsx');
  assert.match(page, /from '\.\.\/\.\.\/utils\/analyticsPolicy'/);
  assert.match(page, /Object\.keys\(EVENTS\) as EventName\[\]\)\.map/);
  assert.match(page, /EVENTS\[name\]\.map\(\(k\) => PARAM_LABELS\[k\]\)/);
  assert.match(page, /CONTEXT_KEYS\.map/);
  for (const must of ['Google Tag Manager', 'Consent Mode v2', '<code>_ga</code>', '_ga_&lt;', '{GA_COOKIE_MONTHS}', '{GA_RETENTION_MONTHS}', 'הגדרות עוגיות', 'מחוץ לישראל', 'אינה נרשמת ואינה נשמרת', 'מה לא נשלח']) {
    assert.ok(page.includes(must), `PrivacyPage.tsx misses "${must}"`);
  }
  // The database definition document lists every event too.
  const dd = read('docs', 'privacy', 'database-definition.md');
  for (const name of Object.keys(EVENTS)) assert.ok(dd.includes('`' + name + '`'), `database-definition.md misses ${name}`);
  for (const k of CONTEXT_KEYS) assert.ok(dd.includes('`' + k + '`'), `database-definition.md misses ${k}`);
  assert.ok(dd.includes(`${GA_RETENTION_MONTHS} חודשים`) && dd.includes(`${GA_COOKIE_MONTHS} חודשים`) && dd.includes(String(GA_COOKIE_EXPIRES_SECONDS)));
});

test('cookie lifetime and retention: one value in code, page, setup guide and GTM container', () => {
  assert.equal(Math.round(GA_COOKIE_EXPIRES_SECONDS / 86400 / 30.4), GA_COOKIE_MONTHS);
  assert.ok(GA_COOKIE_NAME.test('_ga') && GA_COOKIE_NAME.test('_ga_ABC123') && !GA_COOKIE_NAME.test('refreshToken'));
  const guide = read('docs', 'analytics.md');
  assert.ok(guide.includes(`\`cookie_expires\` = \`${GA_COOKIE_EXPIRES_SECONDS}\``), 'docs/analytics.md cookie_expires');
  assert.ok(guide.includes(`set event data retention to ${GA_RETENTION_MONTHS} months`), 'docs/analytics.md retention');
  const tag = JSON.parse(read('docs', 'analytics', 'gtm-container.json')).containerVersion.tag.find((t: any) => t.type === 'googtag');
  const rows = tag.parameter.find((p: any) => p.key === 'configSettingsTable').list.map((r: any) => Object.fromEntries(r.map.map((m: any) => [m.key, m.value])));
  assert.ok(rows.some((r: any) => r.parameter === 'cookie_expires' && r.parameterValue === String(GA_COOKIE_EXPIRES_SECONDS)));
});

test('docs/analytics.md documents every event', () => {
  const doc = read('docs', 'analytics.md');
  for (const name of Object.keys(EVENTS)) assert.match(doc, new RegExp('`' + name + '`'), `docs/analytics.md misses ${name}`);
});

test('GTM container and documented trigger regex cover exactly the allowlisted events', () => {
  const expected = `^(${Object.keys(EVENTS).join('|')})$`;
  const container = JSON.parse(read('docs', 'analytics', 'gtm-container.json'));
  const trig = container.containerVersion.trigger[0].customEventFilter[0].parameter.find((p: any) => p.key === 'arg1').value;
  assert.equal(trig, expected, 'regenerate: cd server && npx tsx ../docs/analytics/build-gtm-container.ts');
  assert.ok(read('docs', 'analytics.md').includes('`' + expected + '`'), 'docs/analytics.md trigger regex is out of date');
  for (const t of container.containerVersion.tag) assert.equal(t.consentSettings?.consentStatus, 'NEEDED', t.name);
});

test('the client sends events only through the allowlisted helper', () => {
  // No component pushes to dataLayer or calls gtag directly.
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(tsx?|jsx?)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const srcDir = path.join(root, 'client', 'src');
  for (const file of walk(srcDir)) {
    if (/utils[\\/]analytics(Policy)?\.ts$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /dataLayer\s*\.push|window\.gtag\s*\(|\bgtag\s*\(/, path.relative(root, file));
  }
});
