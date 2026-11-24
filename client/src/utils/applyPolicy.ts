import { ApplyPolicy, CvRule, GuestMode, JobData } from '../models/interfaces/Props.interfaces';
import { i18n } from '../i18n/I18n';

/*
 * Ways to apply (server: models/schemas/applyPolicy.ts, docs/jobs-management.md "Ways to apply").
 * The server computes the effective policy for each job; the client only reads it.
 *   guestMode  self = apply directly to the employer, quick = guest form, none = sign in first
 *   quickCv / regularCv  'required' | 'optional'
 * A signed-in candidate can always apply the regular way.
 */

/** Today's behaviour; used only when a job payload carries no policy (e.g. an unsaved preview). */
export const DEFAULT_APPLY_POLICY: ApplyPolicy = { guestMode: 'quick', quickCv: 'optional', regularCv: 'optional' };

/** The policy the server computed for this job (override ?? site default). */
export const effectiveApplyPolicy = (job?: Partial<Pick<JobData, 'applyPolicy'>>): ApplyPolicy => {
    const p = job?.applyPolicy as Partial<ApplyPolicy> | undefined;
    return p && p.guestMode ? { ...DEFAULT_APPLY_POLICY, ...p } : DEFAULT_APPLY_POLICY;
};

export const GUEST_MODES: GuestMode[] = ['self', 'quick', 'none'];
export const CV_RULES: CvRule[] = ['required', 'optional'];

export const guestModeLabel = (m: GuestMode) => {
    const t = i18n.getTranslations().ApplyPolicy;
    return m === 'self' ? t.ModeSelf : m === 'quick' ? t.ModeQuick : t.ModeNone;
};
export const guestModeHint = (m: GuestMode) => {
    const t = i18n.getTranslations().ApplyPolicy;
    return m === 'self' ? t.ModeSelfHint : m === 'quick' ? t.ModeQuickHint : t.ModeNoneHint;
};
export const cvRuleLabel = (r: CvRule) => {
    const t = i18n.getTranslations().ApplyPolicy;
    return r === 'required' ? t.CvRequired : t.CvOptional;
};

/** "Default (quick apply)" — the inherit option, naming the current default when it is known. */
export const inheritLabel = (current?: string) => {
    const t = i18n.getTranslations().ApplyPolicy;
    return current ? t.InheritCurrently.replace('{value}', current) : t.Inherit;
};

/** <select> value for an override: '' = inherit. */
export const toSelectValue = (v: string | null | undefined) => v ?? '';
export const fromSelectValue = <T extends string>(v: string): T | null => (v ? (v as T) : null);
