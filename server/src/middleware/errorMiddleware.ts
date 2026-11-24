import { Request, Response, NextFunction } from 'express';
import { isAxiosError } from 'axios';
import { GlobalErrorCodes, GlobalErrorMessages } from '../i18n/i18n.js';
import { AuditWriteError } from '../security/audit.js';
import { safeErrorText } from '../security/pure.js';

/** A daily limit was reached (429, with a message that says an admin was told). */
export class LimitError extends Error {
  constructor(message: string, public budget: string) { super(message); this.name = 'LimitError'; }
}

/** A job imported from the existing site: read-only on this platform (db.ts jobs_imported_readonly). */
export class JobReadOnlyError extends Error {
  constructor() { super('job_read_only'); this.name = 'JobReadOnlyError'; }
}

/** A candidate of the existing site, copied here until the cutover: they view their details, never change them (they DO apply to this site's jobs: owner, 23.11.2026)
 *  (services/legacyCandidates.ts; db.ts users_legacy_guard). Carries status/code for controllers that answer directly. */
export const CANDIDATE_READ_ONLY_MESSAGE = 'הפרטים שלכם הועתקו מאתר המשרות הקודם של SKEELZ. עד המעבר לאתר החדש אפשר רק לצפות בהם (ולהגיש מועמדות למשרות שפורסמו כאן). בקרוב תוכלו גם לעדכן אותם.';
export class CandidateReadOnlyError extends Error {
  status = 409;
  code = 'candidate_read_only';
  /** Passed on by the existing `isAxiosError(e) → next(e)` catch blocks, so every write path answers 409 here. */
  isAxiosError = true;
  constructor() { super(CANDIDATE_READ_ONLY_MESSAGE); this.name = 'CandidateReadOnlyError'; }
}
/** Throws CandidateReadOnlyError for a candidate still mirrored from the existing site. */
export const assertCandidateEditable = (user: { legacyState?: string | null } | null | undefined) => {
  if (user?.legacyState === 'mirror') throw new CandidateReadOnlyError();
};

/** A job of the existing site (imported, or mirrored while that site still manages it): applications to it are not
 *  taken here (owner, 23.11.2026). Jobs created on this site take applications from everyone, a mirrored candidate
 *  included. Refused before anything is claimed or stored (db.ts job_applications_legacy_guard is the backstop). */
export const JOB_ON_EXISTING_SITE_MESSAGE = 'המשרה הזו מנוהלת באתר המשרות הקודם של SKEELZ, ולכן אי אפשר להגיש אליה מועמדות כאן.';
export class JobOnExistingSiteError extends Error {
  status = 409;
  code = 'job_on_existing_site';
  isAxiosError = true;
  constructor() { super(JOB_ON_EXISTING_SITE_MESSAGE); this.name = 'JobOnExistingSiteError'; }
}
/** Throws JobOnExistingSiteError for a job of the existing site (jobDAL.rowToJob onExistingSite). */
export const assertJobTakesApplications = (job: { onExistingSite?: boolean } | null | undefined) => {
  if (job?.onExistingSite) throw new JobOnExistingSiteError();
};

/** The job has a threshold condition (תנאי סף) and the application did not confirm it (thresholdCondition.ts).
 *  The answer carries the current text so the client can show it and ask again. */
export class ThresholdNotConfirmedError extends Error {
  constructor(public condition: string) { super('threshold_not_confirmed'); this.name = 'ThresholdNotConfirmedError'; }
}

export const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof JobReadOnlyError) {
        return res.status(409).json({ message: 'המשרה הזו יובאה מהאתר הקיים, ולכן אי אפשר לשנות, לנעוץ, להקפיץ או למחוק אותה כאן.', code: 'job_read_only' });
    }
    if (err instanceof CandidateReadOnlyError || err instanceof JobOnExistingSiteError) {
        return res.status(409).json({ message: err.message, code: err.code });
    }
    if (err instanceof ThresholdNotConfirmedError) {
        return res.status(400).json({
            message: 'כדי להגיש מועמדות למשרה הזו יש לאשר שאתם עומדים בתנאי הסף שלה.',
            code: 'threshold_not_confirmed',
            thresholdCondition: err.condition,
        });
    }
    if (err instanceof AuditWriteError) {
        // No record → no hand-over of personal data.
        return res.status(503).json({ message: 'יומן הפעילות אינו זמין כרגע, ולכן המידע לא נמסר. נסו שוב בעוד רגע.', code: 'audit_unavailable' });
    }
    if (err instanceof LimitError) {
        return res.status(429).json({ message: err.message, code: `limit_${err.budget}` });
    }
    // Expected refusals (AxiosError with our codes) need no stack; everything else prints safely.
    if (!isAxiosError(err)) console.error(`[error] ${req.method} ${req.path}: ${safeErrorText(err)}`);
    if (isAxiosError(err)) {
        return res.status(400).json({ message: err.message, code: err.code });
    }
    return res.status(500).json({ message:GlobalErrorMessages.GENERAL_ERROR, code:GlobalErrorCodes.GENERAL_ERROR });
}
