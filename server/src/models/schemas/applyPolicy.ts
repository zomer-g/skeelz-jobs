/**
 * Apply policy — the three ways to apply and the CV rules. Pure (no DB): unit tests in
 * test/unit/applyPolicy.test.ts. Rules in docs/jobs-management.md ("Ways to apply").
 *
 * A visitor who is NOT signed in gets one "guest mode" per job:
 *   - 'self'  הגשה עצמאית — the job page shows the employer's contact details / external link and the
 *             visitor applies on their own; nothing goes through SKEELZ (guestApply is refused).
 *   - 'quick' הגשה מהירה — the guest form (name, email, phone, CV); the nonprofit handles it.
 *   - 'none'  — sign in to apply.
 * A registered, signed-in candidate can ALWAYS apply regularly (הגשה רגילה), whatever the guest mode.
 *
 * CV rule, set separately for quick apply and for regular apply: 'required' or 'optional'.
 *   - quick + required:   the guest form must carry an upload.
 *   - regular + required: the profile CV counts; without one the candidate must upload one first.
 *
 * Each setting has a site-wide default (app_settings 'applyPolicy') and an optional per-job override
 * (jobs.guest_mode_override / quick_cv_override / regular_cv_override): null = inherit the default.
 *
 * The job field isSelfApply (Salesforce isSelfApply_cambium__c) is the effective guest mode === 'self';
 * the DB column is_self_apply is kept equal to it (jobDAL).
 */
export type GuestMode = 'self' | 'quick' | 'none';
export type CvRule = 'required' | 'optional';

export const GUEST_MODES: readonly GuestMode[] = ['self', 'quick', 'none'];
export const CV_RULES: readonly CvRule[] = ['required', 'optional'];

export interface ApplyPolicy {
  /** What a visitor who is not signed in can do. */
  guestMode: GuestMode;
  /** CV on a quick (guest) application. */
  quickCv: CvRule;
  /** CV on a regular (registered) application. */
  regularCv: CvRule;
}

/** Per-job overrides; null (or undefined) = use the site-wide default. */
export interface ApplyPolicyOverrides {
  guestModeOverride?: GuestMode | null;
  quickCvOverride?: CvRule | null;
  regularCvOverride?: CvRule | null;
}

export const OVERRIDE_FIELDS = ['guestModeOverride', 'quickCvOverride', 'regularCvOverride'] as const;
export const POLICY_FIELDS = ['guestMode', 'quickCv', 'regularCv'] as const;

/**
 * Today's behaviour when nothing is stored: guests may quick-apply, and neither form has ever
 * required a CV.
 */
export const DEFAULT_APPLY_POLICY: Readonly<ApplyPolicy> = Object.freeze({
  guestMode: 'quick',
  quickCv: 'optional',
  regularCv: 'optional',
});

export const isGuestMode = (v: unknown): v is GuestMode => typeof v === 'string' && (GUEST_MODES as readonly string[]).includes(v);
export const isCvRule = (v: unknown): v is CvRule => typeof v === 'string' && (CV_RULES as readonly string[]).includes(v);

/** Is this a valid value for that override field (null = inherit)? */
export const isValidOverride = (field: (typeof OVERRIDE_FIELDS)[number], v: unknown): boolean =>
  v === null || (field === 'guestModeOverride' ? isGuestMode(v) : isCvRule(v));

/** Is this a valid value for that site-wide field? */
export const isValidPolicyValue = (field: (typeof POLICY_FIELDS)[number], v: unknown): boolean =>
  field === 'guestMode' ? isGuestMode(v) : isCvRule(v);

/** Effective value = job override ?? site-wide default. */
export const resolveApplyPolicy = (job: ApplyPolicyOverrides, defaults: ApplyPolicy): ApplyPolicy => ({
  guestMode: isGuestMode(job.guestModeOverride) ? job.guestModeOverride : defaults.guestMode,
  quickCv: isCvRule(job.quickCvOverride) ? job.quickCvOverride : defaults.quickCv,
  regularCv: isCvRule(job.regularCvOverride) ? job.regularCvOverride : defaults.regularCv,
});

/**
 * Coerces a stored/sent settings value into a full policy. Also reads the old shape
 * ({ quickApply, quickApplyWithoutCv }), so a settings row written before this change keeps its meaning.
 */
export const normalizeApplyPolicy = (value: unknown, fallback: ApplyPolicy = DEFAULT_APPLY_POLICY): ApplyPolicy => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const legacyGuest: GuestMode | undefined = typeof v.quickApply === 'boolean' ? (v.quickApply ? 'quick' : 'none') : undefined;
  const legacyQuickCv: CvRule | undefined =
    typeof v.quickApplyWithoutCv === 'boolean' ? (v.quickApplyWithoutCv ? 'optional' : 'required') : undefined;
  return {
    guestMode: isGuestMode(v.guestMode) ? v.guestMode : legacyGuest ?? fallback.guestMode,
    quickCv: isCvRule(v.quickCv) ? v.quickCv : legacyQuickCv ?? fallback.quickCv,
    regularCv: isCvRule(v.regularCv) ? v.regularCv : fallback.regularCv,
  };
};

/** The old per-job columns -> the new overrides (the one-time migration in config/db.ts does the same in SQL). */
export const legacyOverrides = (r: {
  is_self_apply?: boolean | null; quick_apply_override?: boolean | null; quick_apply_without_cv_override?: boolean | null;
}): ApplyPolicyOverrides => ({
  guestModeOverride: r.is_self_apply ? 'self' : r.quick_apply_override === true ? 'quick' : r.quick_apply_override === false ? 'none' : null,
  quickCvOverride: r.quick_apply_without_cv_override === true ? 'optional' : r.quick_apply_without_cv_override === false ? 'required' : null,
  regularCvOverride: null,
});

export type GuestApplyRejection = 'self-apply-only' | 'quick-apply-disabled' | 'cv-required';

/** Why a guest (quick) application must be refused under this policy, or null when it is allowed. */
export const checkGuestApply = (policy: ApplyPolicy, hasCv: boolean): GuestApplyRejection | null => {
  if (policy.guestMode === 'self') return 'self-apply-only';
  if (policy.guestMode !== 'quick') return 'quick-apply-disabled';
  if (!hasCv && policy.quickCv === 'required') return 'cv-required';
  return null;
};

/**
 * A registered candidate's regular application: always allowed, except without any CV (no profile CV and
 * no upload) when this job requires one.
 */
export const checkRegularApply = (policy: ApplyPolicy, hasCv: boolean): 'cv-required' | null =>
  !hasCv && policy.regularCv === 'required' ? 'cv-required' : null;

/** What the public (API, MCP, job page) is told: the effective guest mode only, never the overrides. */
export const publicApplyMode = (policy: ApplyPolicy): GuestMode => policy.guestMode;

/** The employer's contact details may be shown to the public only on a self-apply job. */
export const showsEmployerContact = (policy: ApplyPolicy): boolean => policy.guestMode === 'self';
