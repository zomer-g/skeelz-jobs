// /privacy and docs/privacy/*.md: one source of truth (client/src/components/privacy/privacyTexts.ts), no
// internal numbers, both regulation documents on the page with linkable anchors, and no detail that maps the system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVACY_DOCUMENTS, PRIVACY_UPDATED, toMarkdown, DATABASE_DEFINITION,
} from '../../client/src/components/privacy/privacyTexts.ts';
import { TERMS_VERSION } from '../src/security/consent.ts';
import { PRIVACY_VERSION } from '../../client/src/components/privacy/privacyTexts.ts';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const all = (d: typeof DATABASE_DEFINITION) =>
  [d.title, d.intro, ...d.sections.flatMap((s) => [s.heading, ...(s.items ?? []), ...(s.paragraphs ?? [])])].join('\n');

test('docs/privacy/*.md are generated from the texts shown on /privacy', () => {
  for (const doc of PRIVACY_DOCUMENTS) {
    assert.equal(read('docs', 'privacy', `${doc.id}.md`).replace(/\r\n/g, '\n'), toMarkdown(doc),
      `docs/privacy/${doc.id}.md differs — run: cd server && npx tsx ../docs/privacy/build-docs.ts`);
  }
});

test('both regulation documents are on the page with the expected anchors', () => {
  assert.deepEqual(PRIVACY_DOCUMENTS.map((d) => d.id), ['database-definition', 'security-procedure']);
  const page = read('client', 'src', 'components', 'privacy', 'PrivacyPage.tsx');
  assert.match(page, /PRIVACY_DOCUMENTS\.map/);
  assert.match(page, /id=\{doc\.id\}/);
  for (const id of ['#database-definition', '#security-procedure']) assert.ok(page.includes(`href="${id}"`), id);
});

// Plain language (owner, 20.11.2026): the texts say WHAT is done, never the internal numbers (limits, alert
// thresholds, review periods, retention), so tuning them needs no new version. Only these digits may appear.
test('the texts quote no internal numbers (limits, thresholds, periods)', () => {
  const docs = PRIVACY_DOCUMENTS.map(all).join('\n').replace(/התשע"ז-2017|תקנה [24]/g, '');
  assert.doesNotMatch(docs, /\d/, 'a number in the regulation documents');
  const html = read('server', 'privacy-versions', `${TERMS_VERSION}.html`).replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"')
    .replace(/<[^>]*$/, '').split(PRIVACY_UPDATED).join('').split(TERMS_VERSION).join('')
    .replace(/התשע"ז-2017|תקנה [24]/g, '').replace(/עד \d+ חודשים/, '');
  assert.doesNotMatch(html, /\d/, 'a number on /privacy other than the version, the date and the cookie lifetime');
});

test('privacy texts name no vendor, refer to no other policy and map no attack surface', () => {
  const page = read('client', 'src', 'components', 'privacy', 'PrivacyPage.tsx').replace(/^\/\/.*$/gm, '');
  const texts = PRIVACY_DOCUMENTS.map(all).join('\n');
  for (const src of [page, texts]) {
    for (const bad of [/xhostd/i, /salesforce/i, /smoov/i, /amazon|\bS3\b|\bSES\b/, /מדיניות הפרטיות הכללית/, /ENABLE_|_SECRET|_ID\b|ADMIN_EMAIL/, /\/api\/|\/mcp\b/]) {
      assert.doesNotMatch(src, bad, `${bad}`);
    }
  }
  // Google may be named only as the sign-in account and the analytics tool the visitor consents to.
  assert.doesNotMatch(texts, /Google Analytics|Tag Manager/);
  assert.ok(/ספקי שירות/.test(page) && /בישראל וחלקם בחו"ל/.test(page), 'service providers in Israel and abroad');
  assert.ok(/צדדים שלישיים במסגרת הסכמים שנחתמו עם העמותה/.test(page), 'third parties under agreements');
});

test('every published version is kept: the current one is stored and equals the page (owner, 19.11.2026)', () => {
  assert.equal(PRIVACY_VERSION, TERMS_VERSION, 'privacyTexts PRIVACY_VERSION = consent.ts TERMS_VERSION');
  assert.ok(fs.existsSync(path.join(root, 'server', 'privacy-versions', `${TERMS_VERSION}.html`)), `server/privacy-versions/${TERMS_VERSION}.html — run: cd client && npm run snapshot:privacy`);
  const r = spawnSync(process.execPath, [path.join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', 'scripts/tsconfig.snapshot.json', 'scripts/snapshot-privacy.tsx', '--check'],
    { cwd: path.join(root, 'client'), encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stderr || r.stdout}`.trim());
});
