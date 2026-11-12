import { ApplyPolicy, JobData } from '../models/interfaces/Props.interfaces';

/** Today's behaviour; used only when a job payload carries no policy (e.g. an unsaved preview). */
export const DEFAULT_APPLY_POLICY: ApplyPolicy = { quickApply: true, quickApplyWithoutCv: true };

/** The policy the server computed for this job (override ?? site default). */
export const effectiveApplyPolicy = (job?: Partial<Pick<JobData, 'applyPolicy'>>): ApplyPolicy =>
    job?.applyPolicy ?? DEFAULT_APPLY_POLICY;

export type OverrideChoice = 'inherit' | 'on' | 'off';

export const overrideToChoice = (v: boolean | null | undefined): OverrideChoice =>
    v === true ? 'on' : v === false ? 'off' : 'inherit';

export const choiceToOverride = (c: OverrideChoice): boolean | null =>
    c === 'on' ? true : c === 'off' ? false : null;
