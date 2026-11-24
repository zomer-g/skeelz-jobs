/* ============================================================================
 *  Salesforce push through the internal API: the same idempotent pushes and the
 *  same stored state as the site's own sync (services/salesforceSync.ts), for
 *  the kinds the internal API exposes (job, application, candidate).
 *
 *  Off unless Salesforce is on (ENABLE_SALESFORCE=true and valid settings): the
 *  routes answer 409 before anything here runs, and the pushes refuse again.
 *  salesforce.pushed (strict, with the candidate ids) is written BEFORE the
 *  first outbound call.
 * ========================================================================== */
export { pendingIds, pushRecords, salesforceEnabled, syncState } from '../services/salesforceSync.js';
export type { PushResult } from '../services/salesforceSync.js';
export { isApiKind as isSyncKind } from '../services/salesforceSyncPure.js';
export type { ApiKind as SyncKind } from '../services/salesforceSyncPure.js';
