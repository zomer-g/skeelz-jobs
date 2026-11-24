/* ============================================================================
 *  npm run sf:check — the Salesforce connection check from a shell (READ ONLY:
 *  signs in and reads metadata; creates, changes and deletes nothing). Uses the
 *  same environment variables as the server (docs/salesforce.md). Prints names,
 *  codes and ok/fail only — never the secret, a token or a record.
 *  Exit code 0 = everything ok, 1 = something to fix.
 * ========================================================================== */
import '../security/redact.js';
import { formatCheckReport, runSalesforceCheck } from '../services/salesforceCheck.js';

const report = await runSalesforceCheck();
console.log(formatCheckReport(report));
process.exit(report.ok ? 0 : 1);
