/* ============================================================================
 *  Which CV goes with a registered candidate's application.
 *
 *  The candidate picks one of:
 *   - profile         apply with the CV already on their profile (may be none)
 *   - replaceProfile  a new upload replaces the profile CV and is used here
 *   - jobOnly         a new upload is used for this application only;
 *                     the profile CV is left as it is
 *
 *  The chosen file's key is stored on the application, so it stays attached to
 *  that application even if the profile CV changes later, and that same key is
 *  what is attached to the Salesforce application Case.
 *
 *  No DB/Salesforce imports here: the side effects come in as `deps`, so the
 *  rules can be tested without a database (test/unit/applicationCv.test.ts).
 * ========================================================================== */
import { AxiosError } from 'axios';
import { JobsErrorCodes, JobsErrorMessages } from '../i18n/i18n.js';

export enum CvMode {
  PROFILE = 'profile',
  REPLACE_PROFILE = 'replaceProfile',
  JOB_ONLY = 'jobOnly',
}

/** Stored on the application: where its CV came from. */
export enum CvScope {
  NONE = '',
  PROFILE = 'profile',
  JOB = 'job',
}

export type CvChoice =
  | { mode: CvMode.PROFILE }
  | { mode: CvMode.REPLACE_PROFILE | CvMode.JOB_ONLY; cvFilePath: string };

const invalidChoice = () => new AxiosError(JobsErrorMessages.INVALID_CV_CHOICE, JobsErrorCodes.INVALID_CV_CHOICE);

/** Reads the `cv` field of the apply request. A missing field means "the profile CV" (older clients). */
export const parseCvChoice = (raw: unknown): CvChoice => {
  if (raw === undefined || raw === null) return { mode: CvMode.PROFILE };
  if (typeof raw !== 'object') throw invalidChoice();
  const { mode, cvFilePath } = raw as Record<string, unknown>;
  if (mode === CvMode.PROFILE) return { mode };
  if (mode === CvMode.REPLACE_PROFILE || mode === CvMode.JOB_ONLY) {
    if (typeof cvFilePath !== 'string' || !cvFilePath || cvFilePath.length > 300) throw invalidChoice();
    return { mode, cvFilePath };
  }
  throw invalidChoice();
};

export interface CvDeps {
  /** Attaches a pending upload to the user; returns its key, or '' if it is not a pending upload. */
  claimUpload: (cvFilePath: string, userId: string) => Promise<string>;
  /** Makes `key` the user's profile CV. */
  setProfileCv: (userId: string, key: string) => Promise<void>;
}

export interface ResolvedCv {
  /** The CV used for this application ('' when the candidate has none). */
  cvFileUrl: string;
  cvScope: CvScope;
  /** Set when the profile CV changed, so the client can update what it shows. */
  newProfileCvFileUrl?: string;
}

export const resolveApplicationCv = async (
  choice: CvChoice,
  user: { id: string; cvFileUrl?: string | null },
  deps: CvDeps
): Promise<ResolvedCv> => {
  if (choice.mode === CvMode.PROFILE) {
    const cvFileUrl = user.cvFileUrl || '';
    return { cvFileUrl, cvScope: cvFileUrl ? CvScope.PROFILE : CvScope.NONE };
  }
  // Only an upload nobody owns yet can be used (never someone else's CV).
  const key = await deps.claimUpload(choice.cvFilePath, user.id);
  if (!key) throw invalidChoice();
  if (choice.mode === CvMode.REPLACE_PROFILE) {
    await deps.setProfileCv(user.id, key);
    return { cvFileUrl: key, cvScope: CvScope.PROFILE, newProfileCvFileUrl: key };
  }
  return { cvFileUrl: key, cvScope: CvScope.JOB };
};

// The application's own CV goes on its Salesforce Case through the sync queue (services/salesforceSync.ts).
