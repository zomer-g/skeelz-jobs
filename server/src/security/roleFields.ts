/* ============================================================================
 *  What a placement coordinator (רכז השמה) may change on a job (owner's decision, 19.11.2026; docs/security.md):
 *  everything on the job form and the jobs-management screen EXCEPT the threshold condition (תנאי סף) and the
 *  job's apply settings (guest mode, CV required). Those stay with content managers and admins.
 *
 *  The job form sends every field on save, so a field counts only when it would CHANGE the stored value
 *  (for a new job: when it is not the default — no condition, no override). Pure: unit-tested in
 *  test/unit/roleFields.test.ts; used by jobController, jobSubmissionController and jobEditRequestController.
 * ========================================================================== */
import { canManageContent } from '../models/enums.js';
import { OVERRIDE_FIELDS } from '../models/schemas/applyPolicy.js';
import { thresholdConditionOf } from '../models/schemas/thresholdCondition.js';

/** Job fields only a content manager (or an admin) may set or change. */
export const CONTENT_MANAGER_FIELDS: readonly string[] = ['thresholdCondition', ...OVERRIDE_FIELDS];

/** The refusal sent to a coordinator (403). Field names only. */
/** Staff never approve, nor forward candidates to, their OWN employer account (security review 24.11.2026, L3): a staff
 *  member who also holds the employer role is an employer like any other for their own jobs. 403 with this code. */
export const OWN_EMPLOYER_ACCOUNT = 'own_employer_account';
export const OWN_EMPLOYER_ACCOUNT_MESSAGE = 'אי אפשר לאשר את זה לחשבון המעסיק שלך. איש צוות אחר מטפל בזה.';

export const CONTENT_MANAGER_REQUIRED = 'content_manager_required';

const norm = (field: string, v: unknown): string | null =>
  field === 'thresholdCondition' ? thresholdConditionOf(v) : (v === undefined || v === null || v === '' ? null : String(v));

/**
 * The restricted fields a caller with this (DB) role would change, [] when allowed.
 * `current` is the job as stored (null for a new job: the defaults). `body.isSelfApply` is the legacy way of
 * setting guest mode 'self' and counts as a change of guestModeOverride when it would set it.
 */
export const restrictedChanges = (role: string | null | undefined, body: Record<string, any> | null | undefined,
  current: Record<string, any> | null): string[] => {
  if (canManageContent(role) || !body || typeof body !== 'object') return [];
  const out: string[] = [];
  for (const f of CONTENT_MANAGER_FIELDS) {
    if (!(f in body) || body[f] === undefined) continue;
    if (norm(f, body[f]) !== norm(f, current ? current[f] : null)) out.push(f);
  }
  if (body.isSelfApply === true && norm('guestModeOverride', current?.guestModeOverride) !== 'self'
    && !out.includes('guestModeOverride')) out.push('guestModeOverride');
  return out;
};

/** Threshold condition carried by an employer's submission / edit request: needs a content manager to approve. */
export const thresholdNeedsContentManager = (role: string | null | undefined, condition: unknown): boolean =>
  !canManageContent(role) && thresholdConditionOf(condition) !== null;
