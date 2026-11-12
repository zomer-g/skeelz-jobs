/* ============================================================================
 *  Employer job submissions.
 *
 *  POST /api/job-submissions (public, rate-limited): an employer sends a job.
 *    Stored in job_submissions as 'pending' — never in "jobs", so the board, the
 *    job page, search, the page data and Salesforce can't see it.
 *  /api/admin/job-submissions/... (staff, contentGate in routes.ts): list, open,
 *    edit, approve (creates the job → public, and Salesforce when on), reject.
 *
 *  The employer's contact details are personal data: shown only when staff open
 *  one submission (logged), never logged or printed themselves.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import * as dal from '../dal/jobSubmissionDAL.js';
import * as jobsService from '../services/jobService.js';
import { query } from '../config/db.js';
import { JobScope, JobStatus } from '../models/enums.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { SUBMISSION_LIMITS, safeErrorText } from '../security/pure.js';
import {
  validateSubmission, isHoneypotHit, descriptionToHtml, cleanReason, SubmissionInput, FieldErrors,
} from '../services/jobSubmissionRules.js';
import appConfig from '../config/appConfig.js';
import * as emailService from '../services/emailService.js';

const invalid = (res: Response, errors: FieldErrors) =>
  res.status(400).json({ message: 'Some fields are missing or invalid', code: 'submission_invalid', fields: errors });

/** City and skills must exist (the client offers only those, but the request can say anything). */
const checkReferences = async (v: Partial<SubmissionInput>, errors: FieldErrors) => {
  if (v.citySymbol !== undefined) {
    const r = await query(`SELECT 1 FROM locations WHERE city_symbol = $1`, [v.citySymbol]);
    if (!r.length) errors.citySymbol = 'invalid';
  }
  if (v.requiredSkills?.length) {
    const r = await query<{ id: string }>(`SELECT id FROM skills WHERE id = ANY($1::text[])`, [v.requiredSkills]);
    if (r.length !== v.requiredSkills.length) errors.requiredSkills = 'invalid';
  }
};

/** Optional staff notification — only when email is on. Title and company only: no contact details in the email. */
const notifyStaff = async (id: string, v: SubmissionInput) => {
  if (appConfig.sendEmailDisabled || !appConfig.applicationNotificationEmail) return;
  const link = appConfig.clientBaseUrl ? `${appConfig.clientBaseUrl.replace(/\/$/, '')}/jobs-management/submissions` : '';
  const text = [
    'משרה חדשה נשלחה בטופס המעסיקים וממתינה לאישור.',
    `משרה: ${v.title}`,
    `חברה: ${v.companyName}`,
    `מזהה: ${id}`,
    link ? `לאישור: ${link}` : '',
  ].filter(Boolean).join('\n');
  await emailService.sendEmail(appConfig.applicationNotificationEmail, 'משרה חדשה ממתינה לאישור', text, true);
};

// ---- public ----

export const submit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    if (isHoneypotHit(body)) {
      // Same answer as a real submission, nothing stored.
      void writeAudit(actorOf(req), 'jobs.submission_dropped', null, { reason: 'honeypot' });
      return res.status(201).json({ data: { message: 'received' } });
    }
    const { value, errors } = validateSubmission(body);
    if (!Object.keys(errors).length) await checkReferences(value, errors);
    if (Object.keys(errors).length) return invalid(res, errors);

    if ((await dal.countPending()) >= SUBMISSION_LIMITS.maxPending) {
      void writeAudit(actorOf(req), 'jobs.submission_dropped', null, { reason: 'queue_full' });
      return res.status(503).json({ message: 'Too many submissions are waiting for review. Please try again later.', code: 'submissions_full' });
    }

    const id = await dal.create(value as SubmissionInput);
    void writeAudit(actorOf(req), 'jobs.submitted', id, null);
    notifyStaff(id, value as SubmissionInput).catch((e) => console.error('[submissions] staff notification failed', safeErrorText(e)));
    return res.status(201).json({ data: { message: 'received' } });
  } catch (error) {
    console.error('[submissions] submit failed', safeErrorText(error));
    next(error);
  }
};

// ---- staff ----

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (dal.STATUSES as string[]).includes(String(req.query.status)) ? (req.query.status as dal.SubmissionStatus) : 'pending';
    const result = await dal.list(status);
    void writeAudit(actorOf(req), 'jobs.submissions_listed', `status:${status}`, { count: result.items.length });
    return res.json({ data: result });
  } catch (error) {
    console.error('[submissions] list failed', safeErrorText(error));
    next(error);
  }
};

export const get = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = await dal.get(req.params.id);
    if (!s) return res.status(404).json({ message: 'Submission not found', code: 'submission_not_found' });
    // Opening one shows the employer's contact details: on record (ids only).
    void writeAudit(actorOf(req), 'jobs.submission_viewed', s.id, { status: s.status });
    return res.json({ data: s });
  } catch (error) {
    console.error('[submissions] get failed', safeErrorText(error));
    next(error);
  }
};

export const edit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { value, errors } = validateSubmission(req.body ?? {}, { partial: true });
    if (!Object.keys(errors).length) await checkReferences(value, errors);
    if (Object.keys(errors).length) return invalid(res, errors);
    const ok = await dal.updatePending(req.params.id, value);
    if (!ok) return res.status(409).json({ message: 'Submission not found or no longer pending', code: 'submission_not_pending' });
    // Field names only — never the values (they include the employer's contact details).
    void writeAudit(actorOf(req), 'jobs.submission_edited', req.params.id, { fields: Object.keys(value) });
    return res.json({ data: await dal.get(req.params.id) });
  } catch (error) {
    console.error('[submissions] edit failed', safeErrorText(error));
    next(error);
  }
};

export const approve = async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  const who = actorOf(req);
  let claimed: dal.Submission | null = null;
  try {
    claimed = await dal.claimForApproval(id, who);
    if (!claimed) return res.status(409).json({ message: 'Submission not found or no longer pending', code: 'submission_not_pending' });
    const job = await jobsService.createJob({
      title: claimed.title,
      companyName: claimed.companyName,
      jobScope: claimed.jobScope as JobScope[],
      publishDate: new Date(),
      citySymbol: claimed.citySymbol,
      description: descriptionToHtml(claimed.description),
      requiredSkills: claimed.requiredSkills,
      // Public on the ad, and the employer said so in the form ("email for applications, shown on the ad").
      contactPersonEmail: claimed.publicEmail ?? undefined,
      externalLink: claimed.externalLink ?? undefined,
      uploadBy: 'employer-form',
      status: JobStatus.ACTIVE,
      comments: `הוגשה בטופס המעסיקים (${claimed.id})`,
      isSponsored: false,
      isMarked: false,
      isSelfApply: !claimed.externalLink,
    } as any);
    await dal.setJob(id, String(job._id));
    void writeAudit(who, 'jobs.submission_approved', id, { job: String(job._id) });
    return res.json({ data: { jobId: String(job._id) } });
  } catch (error) {
    console.error('[submissions] approve failed', safeErrorText(error));
    if (claimed) await dal.releaseClaim(id).catch((e) => console.error('[submissions] release failed', safeErrorText(e)));
    next(error);
  }
};

export const reject = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reason = cleanReason(req.body?.reason);
    const ok = await dal.reject(req.params.id, actorOf(req), reason);
    if (!ok) return res.status(409).json({ message: 'Submission not found or no longer pending', code: 'submission_not_pending' });
    void writeAudit(actorOf(req), 'jobs.submission_rejected', req.params.id, { has_reason: !!reason });
    return res.json({ data: { message: 'rejected' } });
  } catch (error) {
    console.error('[submissions] reject failed', safeErrorText(error));
    next(error);
  }
};
