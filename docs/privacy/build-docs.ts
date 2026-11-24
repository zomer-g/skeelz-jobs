// Writes docs/privacy/<id>.md from the texts shown on /privacy (client/src/components/privacy/privacyTexts.ts).
// Run: cd server && npx tsx ../docs/privacy/build-docs.ts   (server/test/security.test.mjs fails if they differ)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_DOCUMENTS, toMarkdown } from '../../client/src/components/privacy/privacyTexts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const doc of PRIVACY_DOCUMENTS) {
  fs.writeFileSync(path.join(here, `${doc.id}.md`), toMarkdown(doc));
  console.log(`wrote docs/privacy/${doc.id}.md`);
}
