/* Salesforce sync: the pure rules (unit-tested in test/unit/salesforce.test.ts). */

/** Everything the site sends. Order = push order (an application Case points at its job and its candidate). */
export const SYNC_KINDS = ['job', 'candidate', 'employer', 'application', 'guest_application'] as const;
export type SyncKind = typeof SYNC_KINDS[number];
export const isSyncKind = (v: unknown): v is SyncKind => typeof v === 'string' && (SYNC_KINDS as readonly string[]).includes(v);

/** The kinds the internal API may push one by one (internalApi/routes.ts). */
export const API_KINDS = ['job', 'application', 'candidate'] as const;
export type ApiKind = typeof API_KINDS[number];
export const isApiKind = (v: unknown): v is ApiKind => typeof v === 'string' && (API_KINDS as readonly string[]).includes(v);

/** Kinds whose records hand a person's details to Salesforce (the strict log entry names them). */
export const PEOPLE_KINDS: readonly SyncKind[] = ['candidate', 'employer', 'application', 'guest_application'];

/** Waits after the 1st, 2nd… failure in a row; after the last one the record waits for an admin's "retry". */
export const RETRY_DELAYS_S = [60, 5 * 60, 15 * 60, 60 * 60, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600] as const;

/**
 * Failures a retry can't fix by itself: the record is gone or must never be pushed, or Salesforce refused the data
 * (HTTP 400: a missing field, a validation rule, a duplicate rule…), which needs a fix in Salesforce or here first.
 */
export const isPermanentError = (code: string): boolean =>
  ['not_found', 'imported_read_only', 'salesforce_disabled', 'cv_missing', 'beta_field_missing', 'employer_id_field_missing'].includes(code) || /^http_400(_|$)/.test(code)
  || /^candidate_(not_found|http_400|beta_field_missing)/.test(code);

/** Seconds until the next try after `failStreak` failures in a row, or null = stop (until an admin retries). */
export const nextRetryDelay = (code: string, failStreak: number): number | null => {
  if (isPermanentError(code)) return null;
  if (failStreak < 1) return RETRY_DELAYS_S[0];
  return failStreak > RETRY_DELAYS_S.length ? null : RETRY_DELAYS_S[failStreak - 1];
};

export type SyncRowState = 'synced' | 'queued' | 'retrying' | 'failed';
/** One row of salesforce_sync as the admin screen shows it. */
export const syncRowState = (r: { queued_at: unknown; last_error_code: string | null; last_pushed_at: unknown }): SyncRowState =>
  r.queued_at ? (r.last_error_code ? 'retrying' : 'queued') : r.last_error_code ? 'failed' : 'synced';
