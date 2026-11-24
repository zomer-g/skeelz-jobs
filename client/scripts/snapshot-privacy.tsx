// Keeps every published version of the privacy policy + terms (owner, 19.11.2026): renders /privacy to static HTML
// and writes server/privacy-versions/<TERMS_VERSION>.html, which the server adds to privacy_versions on migrate
// (never changed afterwards). Run after changing the texts and bumping the version:
//   cd client && npm run snapshot:privacy           write the file for a NEW version (refuses to change an existing one)
//   cd client && npm run snapshot:privacy -- --check  exit 1 when the page differs from the stored file (npm test runs it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import PrivacyPage from '../src/components/privacy/PrivacyPage';
import { PRIVACY_VERSION } from '../src/components/privacy/privacyTexts';
import { TERMS_VERSION } from '../../server/src/security/consent';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', '..', 'server', 'privacy-versions');
const check = process.argv.includes('--check');

if (PRIVACY_VERSION !== TERMS_VERSION) {
  console.error(`PRIVACY_VERSION (${PRIVACY_VERSION}) and TERMS_VERSION (${TERMS_VERSION}) differ: bump both together`);
  process.exit(1);
}
const html = `<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8"><title>מדיניות פרטיות — גרסה ${TERMS_VERSION}</title></head>\n<body>\n${renderToStaticMarkup(<PrivacyPage />)}\n</body></html>\n`;
const file = path.join(dir, `${TERMS_VERSION}.html`);
const stored = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n') : null;

if (check) {
  if (stored === null) { console.error(`no stored version ${TERMS_VERSION}: run npm run snapshot:privacy`); process.exit(1); }
  if (stored !== html) { console.error(`the privacy page differs from stored version ${TERMS_VERSION}: bump the version and run npm run snapshot:privacy`); process.exit(1); }
  console.log(`privacy version ${TERMS_VERSION}: page = stored file`);
  process.exit(0);
}
if (stored !== null && stored !== html) {
  console.error(`version ${TERMS_VERSION} is already published with other text; a published version never changes — bump TERMS_VERSION and PRIVACY_VERSION`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, html);
console.log(`wrote ${path.relative(path.resolve(here, '..', '..'), file)}`);
