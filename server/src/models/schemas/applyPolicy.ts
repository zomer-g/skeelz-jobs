/**
 * Apply policy: whether a visitor may apply without registering ("quick apply",
 * הגשה מהירה) and whether such an application may come without a CV.
 *
 * Each setting has a site-wide default (app_settings) and an optional per-job
 * override (jobs.quick_apply_override / jobs.quick_apply_without_cv_override):
 * null = inherit the default, true/false = this job's own value.
 */
export interface ApplyPolicy {
  /** Guests may apply without registering. */
  quickApply: boolean;
  /** A guest application may be sent without a CV (only meaningful when quickApply). */
  quickApplyWithoutCv: boolean;
}

/** Per-job overrides; null (or undefined) = use the site-wide default. */
export interface ApplyPolicyOverrides {
  quickApplyOverride?: boolean | null;
  quickApplyWithoutCvOverride?: boolean | null;
}

/**
 * Today's behaviour, used when no settings record exists yet: quick apply is on,
 * and the guest form has never required a CV (the upload is optional there and
 * the server accepted applications without one).
 */
export const DEFAULT_APPLY_POLICY: Readonly<ApplyPolicy> = Object.freeze({
  quickApply: true,
  quickApplyWithoutCv: true,
});

const pick = (override: boolean | null | undefined, fallback: boolean) =>
  typeof override === 'boolean' ? override : fallback;

/** Effective value = job override ?? site-wide default. */
export const resolveApplyPolicy = (job: ApplyPolicyOverrides, defaults: ApplyPolicy): ApplyPolicy => ({
  quickApply: pick(job.quickApplyOverride, defaults.quickApply),
  quickApplyWithoutCv: pick(job.quickApplyWithoutCvOverride, defaults.quickApplyWithoutCv),
});

/** Coerces stored/sent settings into a full policy (unknown or bad fields fall back). */
export const normalizeApplyPolicy = (value: unknown, fallback: ApplyPolicy = DEFAULT_APPLY_POLICY): ApplyPolicy => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    quickApply: typeof v.quickApply === 'boolean' ? v.quickApply : fallback.quickApply,
    quickApplyWithoutCv: typeof v.quickApplyWithoutCv === 'boolean' ? v.quickApplyWithoutCv : fallback.quickApplyWithoutCv,
  };
};

export type GuestApplyRejection = 'quick-apply-disabled' | 'cv-required';

/** Why a guest application must be refused under this policy, or null when it is allowed. */
export const checkGuestApply = (policy: ApplyPolicy, hasCv: boolean): GuestApplyRejection | null => {
  if (!policy.quickApply) return 'quick-apply-disabled';
  if (!hasCv && !policy.quickApplyWithoutCv) return 'cv-required';
  return null;
};
