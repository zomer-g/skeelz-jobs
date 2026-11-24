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
import { JobScope, JobStatus, canManageContent, isEmployer } from '../models/enums.js';
import { actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { SUBMISSION_LIMITS, safeErrorText } from '../security/pure.js';
import { checkConsent } from '../security/consent.js';
import {
  validateSubmission, isHoneypotHit, descriptionToHtml, cleanReason, SubmissionInput, FieldErrors,
} from '../services/jobSubmissionRules.js';
import appConfig from '../config/appConfig.js';
import { mailStaffJobSubmission, mailSubmissionDecision } from '../mail/triggers.js';
import * as settingsService from '../services/settingsService.js';
import * as employerDAL from '../dal/employerDAL.js';
import { queueSalesforce } from '../services/salesforceSync.js';
import { postingRefusal } from '../security/employer.js';
import { CONTENT_MANAGER_REQUIRED, thresholdNeedsContentManager } from '../security/roleFields.js';
import { thresholdConditionOf } from '../models/schemas/thresholdCondition.js';
import * as customFields from '../services/customFieldsService.js';
import { checkCustomValues, CustomValue, errorCodesOf, mergeCustomValues, shownValues } from '../models/schemas/customFields.js';

/** The job form's added fields (settings screen) in the employer form: same rules as the staff form. */
const checkExtra = async (raw: unknown, requireAll: boolean, errors: FieldErrors): Promise<Record<string, CustomValue | null>> => {
  const defs = await customFields.definitionsOf('job');
  const r = checkCustomValues(defs, raw, { requireAll });
  if (!r.ok) Object.assign(errors, errorCodesOf(defs, raw, r.bad));
  return r.ok ? r.values : {};
};
/** Stored answers → what a job takes now (fields turned off or options removed since are dropped, never refused). */
export const currentlyValid = async (stored: unknown): Promise<Record<string, CustomValue | null>> => {
  const defs = await customFields.definitionsOf('job');
  const src: Record<string, unknown> = { ...mergeCustomValues(stored, {}) };
  for (let i = 0; i < 3; i++) {
    const r = checkCustomValues(defs, src);
    if (r.ok) return r.values;
    for (const id of r.bad) delete src[id];
  }
  return {};
};

/** A coordinator and a threshold condition (תנאי סף): only a content manager sets or approves one. */
const needsContentManager = (res: Response) =>
  (auditDenied(res.req, CONTENT_MANAGER_REQUIRED), res.status(403)).json({ message: 'משרה עם תנאי סף מאושרת על ידי מנהל תוכן', code: CONTENT_MANAGER_REQUIRED, fields: ['thresholdCondition'] });

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

/** The team's notice (src/mail, kind staff_job_submission). Title and company only: no contact details in the email. */
const notifyStaff = async (id: string, v: SubmissionInput) => {
  await mailStaffJobSubmission(id, { title: v.title, companyName: v.companyName });
};

// ---- public ----

export const submit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    // The setting (docs/employers.md): 'account_required' → only a signed-in employer (DB role) may send a job.
    // Several roles per account: someone who holds the employer role posts as the employer, whatever else they are.
    const employer = isEmployer(req.authUser);
    const role = employer ? 'employer' : (req.authUser?.role ?? null);
    const refusal = postingRefusal(await settingsService.getEmployerPosting(), role);
    if (refusal === 'sign_in') {
      return res.status(401).json({ message: 'Sign in with an employer account to post a job', code: 'employer_sign_in_required' });
    }
    if (refusal === 'employer_only') {
      void writeAudit(actorOf(req), 'access.denied', 'job-submissions', { reason: `employer_only:${role}` });
      return res.status(403).json({ message: 'Only an employer account can post a job', code: 'employer_account_required' });
    }
    const ownerId = employer ? req.authUser!.id : null;
    if (isHoneypotHit(body)) {
      // Same answer as a real submission, nothing stored.
      void writeAudit(actorOf(req), 'jobs.submission_dropped', null, { reason: 'honeypot' });
      return res.status(201).json({ data: { message: 'received' } });
    }
    const { value, errors } = validateSubmission(body);
    const extra = await checkExtra(body.customFields, true, errors);
    // The required box is checked by validateSubmission (errors.consent); the optional marketing box here.
    const consent = checkConsent(body, { needTerms: true, askMarketing: true });
    if (consent.error === 'marketing_invalid' || consent.error === 'marketing_required') errors.marketingConsent = consent.error === 'marketing_invalid' ? 'invalid' : 'required';
    if (!Object.keys(errors).length) await checkReferences(value, errors);
    if (Object.keys(errors).length) return invalid(res, errors);

    if ((await dal.countPending()) >= SUBMISSION_LIMITS.maxPending) {
      void writeAudit(actorOf(req), 'jobs.submission_dropped', null, { reason: 'queue_full' });
      return res.status(503).json({ message: 'Too many submissions are waiting for review. Please try again later.', code: 'submissions_full' });
    }

    const id = await dal.create(value as SubmissionInput, { marketing: consent.value.marketing === true }, ownerId, mergeCustomValues({}, extra));
    const extraNames = Object.keys(mergeCustomValues({}, extra)).map((k) => `customFields.${k}`);
    void writeAudit(actorOf(req), 'jobs.submitted', id, ownerId || extraNames.length ? { ...(ownerId ? { by_account: true } : {}), ...(extraNames.length ? { fields: extraNames } : {}) } : null);
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
    // The added job fields with their labels, for the review screen.
    return res.json({ data: { ...s, extraFields: shownValues(await customFields.definitionsOf('job'), s.customFields) } });
  } catch (error) {
    console.error('[submissions] get failed', safeErrorText(error));
    next(error);
  }
};

export const edit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { value, errors } = validateSubmission(req.body ?? {}, { partial: true });
    const extra = req.body?.customFields === undefined ? {} : await checkExtra(req.body.customFields, false, errors);
    if (!Object.keys(errors).length) await checkReferences(value, errors);
    if (Object.keys(errors).length) return invalid(res, errors);
    if ('thresholdCondition' in value && !canManageContent(req.authUser?.role)) {
      // A coordinator may edit a pending submission but not change its threshold condition.
      const cur = await dal.get(req.params.id);
      if (cur && thresholdConditionOf((value as any).thresholdCondition) !== thresholdConditionOf(cur.thresholdCondition)) return needsContentManager(res);
    }
    const ok = await dal.updatePending(req.params.id, value);
    if (!ok) return res.status(409).json({ message: 'Submission not found or no longer pending', code: 'submission_not_pending' });
    await customFields.saveSubmissionValues(req.params.id, extra);
    // Field names only — never the values (they include the employer's contact details).
    void writeAudit(actorOf(req), 'jobs.submission_edited', req.params.id, { fields: [...Object.keys(value), ...Object.keys(extra).map((k) => `customFields.${k}`)] });
    const s = await dal.get(req.params.id);
    return res.json({ data: s ? { ...s, extraFields: shownValues(await customFields.definitionsOf('job'), s.customFields) } : s });
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
    // A submission with a threshold condition is approved by a content manager (or an admin), not a coordinator.
    if (thresholdNeedsContentManager(req.authUser?.role, (await dal.get(id))?.thresholdCondition)) return needsContentManager(res);
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
      thresholdCondition: claimed.thresholdCondition ?? undefined,
      uploadBy: 'employer-form',
      status: JobStatus.ACTIVE,
      comments: `הוגשה בטופס המעסיקים (${claimed.id})`,
      isSponsored: false,
      isMarked: false,
      isSelfApply: !claimed.externalLink,
    } as any);
    await dal.setJob(id, String(job._id));
    // The added job fields go with it (as the definitions are now; see currentlyValid).
    await customFields.saveJobValues(String(job._id), await currentlyValid(claimed.customFields));
    // Sent by an employer account: the job is theirs (their personal area, edit requests).
    if (claimed.ownerId) {
      await employerDAL.linkJob(String(job._id), claimed.ownerId, 'submission');
      void queueSalesforce('job', String(job._id)); // its Case points at the employer's Contact (off → nothing)
    }
    void writeAudit(who, 'jobs.submission_approved', id, { job: String(job._id), ...(claimed.ownerId ? { by_account: true } : {}) });
    // The employer is told (when the event is on; src/mail).
    void mailSubmissionDecision({ contactEmail: claimed.contactEmail, contactName: claimed.contactName, title: claimed.title }, { approved: true, jobId: String(job._id) });
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
    const before = await dal.get(req.params.id);
    const ok = await dal.reject(req.params.id, actorOf(req), reason);
    if (!ok) return res.status(409).json({ message: 'Submission not found or no longer pending', code: 'submission_not_pending' });
    void writeAudit(actorOf(req), 'jobs.submission_rejected', req.params.id, { has_reason: !!reason });
    if (before) void mailSubmissionDecision({ contactEmail: before.contactEmail, contactName: before.contactName, title: before.title }, { approved: false, reason });
    return res.json({ data: { message: 'rejected' } });
  } catch (error) {
    console.error('[submissions] reject failed', safeErrorText(error));
    next(error);
  }
};
