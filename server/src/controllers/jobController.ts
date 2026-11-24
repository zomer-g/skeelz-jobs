import { NextFunction, Request, Response } from 'express';
import { isValidOverride, OVERRIDE_FIELDS } from '../models/schemas/applyPolicy.js';
import * as jobsService from '../services/jobService.js';
import * as jobApplicationService from '../services/jobApplicationService.js';
import { AxiosError, isAxiosError } from 'axios';
import { AuthErrorCodes, AuthErrorMessages, JobsErrorCodes, JobsErrorMessages } from '../i18n/i18n.js';
import { filterOptions } from '../models/interfaces/general.interface.js';
import { CreateJobDTO } from '../dto/createJobDto.js';
import { UpdateJobDto } from '../dto/updateJobDto.js';
import { UserRole, canManageContent, canViewStaffData } from '../models/enums.js';
import { CONTENT_MANAGER_REQUIRED, restrictedChanges } from '../security/roleFields.js';
import { AuditWriteError, actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { peopleHandover } from '../security/handover.js';
import { CandidateReadOnlyError, JobOnExistingSiteError, JobReadOnlyError, LimitError, ThresholdNotConfirmedError, assertJobTakesApplications } from '../middleware/errorMiddleware.js';
import { safeErrorText } from '../security/pure.js';
import { checkPublishDate, isOpenByLink } from '../models/schemas/jobBoard.js';
import { isObjectId } from '../utils/ids.js';
import * as userDAL from '../dal/userDAL.js';
import { applyConsent, checkConsent } from '../security/consent.js';
import { checkThresholdCondition, isThresholdConfirmed } from '../models/schemas/thresholdCondition.js';
import { checkValues as checkCustomValues, saveJobValues } from '../services/customFieldsService.js';
import { CustomValue } from '../models/schemas/customFields.js';

const PUBLISH_DATE_MESSAGES: Record<string, string> = {
  invalid: 'publishDate is not a valid date',
  too_early: 'publishDate is too early',
  future_needs_schedule: 'publishDate is in the future: send schedulePublish=true to schedule it (hidden until then)',
  too_far: 'publishDate can be scheduled at most 365 days ahead',
};

/** Validates body.publishDate (when present) and removes the schedulePublish flag (not stored).
 *  Returns an error code, or null when fine. Exported for the internal API. */
export const takePublishDate = (body: any, required = false): string | null => {
  const schedule = body?.schedulePublish === true;
  if (body && 'schedulePublish' in body) delete body.schedulePublish;
  if (body?.publishDate === undefined) return required ? 'invalid' : null;
  const r = checkPublishDate(body.publishDate, new Date(), schedule);
  if (!r.ok) return r.code;
  body.publishDate = r.date;
  return null;
};

/** body.thresholdCondition (when present): plain text, cleaned in place. Returns an error code, or null when fine. */
export const takeThresholdCondition = (body: any): string | null => {
  if (!body || body.thresholdCondition === undefined) return null;
  const c = checkThresholdCondition(body.thresholdCondition);
  if (!c.ok) return c.error;
  body.thresholdCondition = c.value;
  return null;
};
/** The job form's added fields (settings screen): takes body.customFields off the body (the job columns never see it)
 *  and checks it; a new job must answer every active required one. */
const takeCustomValues = async (body: any, isNew: boolean): Promise<{ ok: true; values: Record<string, CustomValue | null> } | { ok: false; bad: string[] }> => {
  const raw = body?.customFields;
  if (body) delete body.customFields;
  if (raw === undefined && !isNew) return { ok: true, values: {} };
  return checkCustomValues('job', raw, { requireAll: isNew });
};
const badCustom = (res: Response, bad: string[]) =>
  res.status(400).json({ message: 'customFields are not valid', code: 'custom_fields_invalid', fields: bad.map((id) => `customFields.${id}`) });
const customNames = (values: Record<string, unknown>) => Object.keys(values).map((id) => `customFields.${id}`);
const badThreshold = (res: Response, code: string) =>
  res.status(400).json({ message: 'thresholdCondition is not valid', code: `threshold_condition_${code}` });

/** A placement coordinator tried to set or change a field only a content manager may (security/roleFields.ts). */
const needsContentManager = (res: Response, fields: string[]) =>
  (auditDenied(res.req, CONTENT_MANAGER_REQUIRED), res.status(403)).json({ message: 'רק מנהל תוכן יכול לשנות תנאי סף או הגדרות הגשה', code: CONTENT_MANAGER_REQUIRED, fields });

const badDate = (res: Response, code: string) =>
  res.status(400).json({ message: PUBLISH_DATE_MESSAGES[code] ?? 'bad publishDate', code: `publish_date_${code}` });


export const adminFetchAllJobs = async (req: Request, res: Response, next: NextFunction) => {
  const filterParams = req.query.filterOptions as filterOptions;
  try {
    const {jobs, total} = await jobsService.fetchAllJobs(filterParams);
    void writeAudit(actorOf(req), 'jobs.internal_listed', 'GET /api/admin/jobs/with-comments', { count: jobs?.length ?? 0, total });
    return res.json({ data: {jobs, total} });
  } catch (error) {
    console.error('[jobs] admin list failed', safeErrorText(error));
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED));
  }
}

export const fetchActiveJobs = async (req: Request, res: Response, next: NextFunction) => {
  const filterParams = req.query.filterOptions as filterOptions;
  try {
    let jobs = await jobsService.getActiveJobsWithoutComments(filterParams);
    return res.json({ data: jobs });
  } catch (error) {
    console.error('[jobs] public list failed', safeErrorText(error));
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED));
  }
}

// Israel and a margin around it; anything else is a bad request.
const NEAR_BOUNDS = { minLat: 29, maxLat: 34, minLng: 34, maxLng: 36.5 };
const MAX_RADIUS_KM = 200;

export const fetchActiveJobsNear = async (req: Request, res: Response, next: NextFunction) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm);
  if (![lat, lng, radiusKm].every(Number.isFinite)
    || lat < NEAR_BOUNDS.minLat || lat > NEAR_BOUNDS.maxLat
    || lng < NEAR_BOUNDS.minLng || lng > NEAR_BOUNDS.maxLng
    || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
    return res.status(400).json({ message: 'lat, lng (inside Israel) and radiusKm (0-200) are required' });
  }
  const raw = req.query.filterOptions;
  const filterParams = (raw && typeof raw === 'object' ? raw : {}) as filterOptions;
  try {
    const data = await jobsService.getActiveJobsNear(lat, lng, radiusKm, filterParams);
    return res.json({ data });
  } catch (error) {
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED));
  }
}

export const createNewJob = async (req: Request, res: Response, next: NextFunction) => {
  const createJobDTO = req.body as CreateJobDTO;
  const dateError = takePublishDate(createJobDTO, true);
  if (dateError) return badDate(res, dateError);
  const thresholdError = takeThresholdCondition(createJobDTO);
  if (thresholdError) return badThreshold(res, thresholdError);
  const restricted = restrictedChanges(req.authUser?.role, createJobDTO as any, null);
  if (restricted.length) return needsContentManager(res, restricted);
  const extra = await takeCustomValues(createJobDTO, true);
  if (!extra.ok) return badCustom(res, extra.bad);
  try {
    const created: any = await jobsService.createJob(createJobDTO);
    if (created?._id) await saveJobValues(String(created._id), extra.values);
    void writeAudit(actorOf(req), 'job.created', created?._id ? String(created._id) : null, {
      title: String(createJobDTO?.title ?? '').slice(0, 200),
      fields: [...Object.keys(createJobDTO ?? {}).filter((k) => (createJobDTO as any)[k] !== undefined), ...customNames(extra.values)].slice(0, 30),
    });
    return res.json({ data: { message: "Job created successfully", id: created?._id ?? null } });
  } catch (error) {
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.CREATE_JOB_FAILED, JobsErrorCodes.CREATE_JOB_FAILED));
  }
}

export const updateJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const jobId = req.params.jobId;
    const updateJobDto: UpdateJobDto = req.body;
    const dateError = takePublishDate(updateJobDto);
    if (dateError) { badDate(res, dateError); return; }
    const thresholdError = takeThresholdCondition(updateJobDto);
    if (thresholdError) { badThreshold(res, thresholdError); return; }
    const extra = await takeCustomValues(updateJobDto, false);
    if (!extra.ok) { badCustom(res, extra.bad); return; }
    if (!canManageContent(req.authUser?.role)) {
      // A coordinator: the form sends every field, so only a CHANGE of a content manager's field is refused.
      const current = await jobsService.fetchJobById(jobId, { withComments: true });
      if (!current) { res.status(404).json({ data: { message: 'Job not found' } }); return; }
      const restricted = restrictedChanges(req.authUser?.role, updateJobDto as any, current as any);
      if (restricted.length) { needsContentManager(res, restricted); return; }
    }

    const updatedJob = await jobsService.updateJobById(jobId, updateJobDto);

    if (updatedJob) {
      await saveJobValues(String(updatedJob._id), extra.values); // after assertJobEditable (existing-site jobs refused)
      void writeAudit(actorOf(req), 'job.updated', String(updatedJob._id), {
        fields: [...Object.keys(updateJobDto ?? {}).filter((k) => (updateJobDto as any)[k] !== undefined), ...customNames(extra.values)].slice(0, 30),
      });
      res.status(200).json({
        data: {
          message: 'Job updated successfully',
          userId: updatedJob._id,
        }
      });
    } else {
      res.status(404).json({ data: { message: 'Job not found' } });
    }
  } catch (error) {
    if (isAxiosError(error) || error instanceof JobReadOnlyError) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.UPDATE_JOB_FAILED, JobsErrorCodes.UPDATE_JOB_FAILED));
  }
};

export const fetchJobById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = req.params.jobId ?? "";
    // Internal comments are for content managers only (they used to be public).
    // Staff (coordinators too) see internal comments and non-public jobs.
    const isContentManager = canViewStaffData(req.authJwtPayload?.userRole);
    let job = await jobsService.fetchJobById(jobId, { withComments: isContentManager });
    // Archived and not-yet-published (scheduled) jobs: only content managers. Private jobs open by link.
    if (!job || (!isContentManager && !isOpenByLink(job))) {
      return res.status(404).json({ data: null, message: 'Job not found' });
    }
    return res.json({ data: job });
  } catch (error) {
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED));
  }
}

export const fetchJobApplicationsByUserId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId ?? "";
    let job = await jobApplicationService.findJobsApplictionByUserId(userId);
    return res.json({ data: job });
  } catch (error) {
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED));
  }
}

export const findAllJobApplictionsDetailsByUserId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId;
    // Everyone sees their own applications; only content managers see someone else's (admins don't).
    const { userID, userRole } = req.authJwtPayload!;
    if (!canViewStaffData(userRole) && userID !== userId) {
      return next(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN));
    }
    const filterParams = req.query.filterOptions as filterOptions;
    if (userID === userId) {
      // A candidate's own applications: no hand-over to anyone else.
      const own = await jobApplicationService.findAllJobApplictionsDetailsByUserId(userId, filterParams);
      return res.json({ data: own });
    }
    // A content manager looking at someone's applications: recorded and counted.
    let job: any;
    await peopleHandover({
      who: actorOf(req),
      action: 'candidate.applications_viewed',
      place: 'GET /api/users/job-applications/:userId',
      details: { subject: userId },
      load: async () => { job = await jobApplicationService.findAllJobApplictionsDetailsByUserId(userId, filterParams); return [userId]; },
      idOf: (id) => id,
    });
    return res.json({ data: job });
  } catch (error) {
    if (error instanceof AuditWriteError || error instanceof LimitError) return next(error);
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.FETCH_JOB_APPLICATIONS_FAILED, JobsErrorCodes.FETCH_JOB_APPLICATIONS_FAILED));
  }
}

/** Thrown by the consent check of addJobApplication: the boxes are still missing (→ 428 consent_needed). */
class ConsentNeeded extends Error {}

export const applyJob = async (req: Request, res: Response, next: NextFunction) => {
  const { userID } = req.authJwtPayload!;
  const jobIdNumber = req.params.jobId;

  try {
    // A job of the existing site takes no applications here: refused before any consent is recorded. Jobs created
    // on this site take applications from every candidate, one copied from the existing site included (owner, 23.11.2026).
    assertJobTakesApplications(await jobsService.fetchJobById(String(jobIdNumber ?? '')));
    // Terms not accepted in their current version, or the marketing question never answered → the client shows
    // the boxes once and sends the answers with the same request (security/consent.ts). Checked and stored only
    // after the job, duplicate, threshold and CV rules passed (addJobApplication): a refused application stores no
    // consent, and a missing CV is reported before the consent question.
    const state = await userDAL.getConsent(userID);
    const consent = applyConsent(state ?? { termsVersion: null, marketingConsent: null }, req.body);
    const answered = consent.record.terms || consent.record.marketing !== undefined;
    // body.cv: which CV goes with this application (services/applicationCv.ts).
    // body.thresholdConfirmed: the candidate confirmed the job's threshold condition (refused without it when the
    // job has one: thresholdCondition.ts).
    let result;
    try {
      result = await jobApplicationService.addJobApplication(userID, jobIdNumber, req.body?.cv, isThresholdConfirmed(req.body), {
        check: () => { if (consent.missing) throw new ConsentNeeded(); },
        record: async () => { if (answered) await userDAL.recordConsent(userID, consent.record); },
      });
    } catch (e) {
      if (e instanceof ConsentNeeded) {
        return res.status(428).json({ message: 'Consent is required', code: 'consent_needed', needTerms: consent.needTerms, needMarketing: consent.needMarketing });
      }
      throw e;
    }
    void writeAudit(actorOf(req), 'job.applied', String(jobIdNumber),
      answered ? { terms_accepted: !!consent.record.terms, marketing: consent.record.marketing } : null);
    return res.json({ data: {message: 'Application submitted successfully', ...result}});
  } catch (error) {
    if (isAxiosError(error) || error instanceof ThresholdNotConfirmedError || error instanceof CandidateReadOnlyError || error instanceof JobOnExistingSiteError) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.APPLY_JOB, JobsErrorCodes.APPLY_JOB));
  }
};

export const guestApplyJob = async (req: Request, res: Response, next: NextFunction) => {
  const jobData = req.body?.jobData;
  const guestApplication = req.body?.guestData;
  if (!guestApplication?.email || !jobData?._id) {
    return next(new AxiosError(JobsErrorMessages.APPLY_JOB, JobsErrorCodes.APPLY_JOB));
  }
  const consent = checkConsent(req.body, { needTerms: true, askMarketing: true });
  if (!consent.ok) return res.status(400).json({ message: 'Consent is required', code: consent.error });
  // The answer is the same whether or not the email has an account (it used to
  // answer "user exists", which told anyone who is registered). An application
  // with a registered email is taken as a guest application like any other.
  try {
    const marketing = consent.value.marketing === true;
    await jobApplicationService.guestApplyJob(jobData, guestApplication, { marketing, actor: `anonymous:${req.ip}` }, isThresholdConfirmed(req.body));
    void writeAudit(`anonymous:${req.ip}`, 'guest.applied', String(jobData?._id ?? ''), { has_cv: !!guestApplication?.cvFilePath, marketing });
    return res.json({ data: { message: 'Application submitted successfully' } });
  } catch (error) {
    if (isAxiosError(error) || error instanceof ThresholdNotConfirmedError) {
      return next(error);
    }
    next(new AxiosError(JobsErrorMessages.APPLY_JOB, JobsErrorCodes.APPLY_JOB));
  }
};

// ---- jobs-management screen (content managers; docs/jobs-management.md) ----

const notFound = (res: Response) => res.status(404).json({ data: null, message: 'Job not found' });
const jobIdOf = (req: Request) => String(req.params.jobId ?? '');

/** POST /admin/jobs/:jobId/pin — pin (נעץ): stays at the start of the public lists until unpinned. */
export const pinJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.setPinned(id, true);
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.pinned', id, { fields: ['pinnedAt'] });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

/** POST /admin/jobs/:jobId/bump — bump (הקפצה): once to the top (see jobDAL.bumpJob). */
export const bumpJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.bumpJob(id);
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.bumped', id, { fields: job.pinnedAt ? ['pinnedAt'] : ['bumpedAt'] });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

/** DELETE /admin/jobs/:jobId/pin */
export const unpinJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.setPinned(id, false);
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.unpinned', id, { fields: ['pinnedAt'] });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

// What the list's inline controls may change (everything else goes through the full form, PATCH /jobs/:jobId).
const BOARD_FIELDS = ['isSponsored', 'publishDate', 'status', ...OVERRIDE_FIELDS] as const;
const STATUSES = ['Active', 'Suspended', 'Closed'];

/** PATCH /admin/jobs/:jobId/board — inline edits from the list (sponsored, publish date, status,
 *  apply-policy overrides). Strict allowlist; field names only in the log. */
export const updateJobBoard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    if (!isObjectId(id)) return notFound(res);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter((k) => !(BOARD_FIELDS as readonly string[]).includes(k) && k !== 'schedulePublish');
    if (unknown.length) return res.status(400).json({ message: `not editable here: ${unknown.slice(0, 5).join(', ')}`, code: 'bad_field' });
    const dto: Record<string, any> = { ...body };
    for (const k of ['isSponsored']) {
      if (k in dto && typeof dto[k] !== 'boolean') return res.status(400).json({ message: `${k}: true or false`, code: 'bad_value' });
    }
    for (const k of OVERRIDE_FIELDS) {
      if (k in dto && !isValidOverride(k, dto[k])) {
        const allowed = k === 'guestModeOverride' ? 'self, quick, none' : 'required, optional';
        return res.status(400).json({ message: `${k}: ${allowed} or null`, code: 'bad_value' });
      }
    }
    if ('status' in dto && !STATUSES.includes(dto.status)) return res.status(400).json({ message: 'status: Active, Suspended or Closed', code: 'bad_value' });
    const dateError = takePublishDate(dto);
    if (dateError) return badDate(res, dateError);
    const fields = Object.keys(dto);
    if (!fields.length) return res.status(400).json({ message: 'nothing to change', code: 'bad_value' });
    if (!canManageContent(req.authUser?.role)) {
      const current = await jobsService.fetchJobById(id, { withComments: true });
      if (!current) return notFound(res);
      const restricted = restrictedChanges(req.authUser?.role, dto, current as any);
      if (restricted.length) return needsContentManager(res, restricted);
    }
    const job = await jobsService.updateJobById(id, dto as UpdateJobDto, 'screen');
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.board_updated', id, { fields });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

/** POST /admin/jobs/:jobId/archive — soft delete. Applications are kept (and a DB trigger refuses a hard delete). */
export const archiveJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.setArchived(id, true, actorOf(req));
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.archived', id, { fields: ['deletedAt'] });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

/** POST /admin/jobs/:jobId/restore — undo an archive. */
export const restoreJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.setArchived(id, false, actorOf(req));
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.restored', id, { fields: ['deletedAt'] });
    return res.json({ data: job });
  } catch (error) { next(error); }
};

/** GET /admin/jobs/:jobId/applications-count — a number only (the delete dialog says they are kept). */
export const jobApplicationsCount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    if (!isObjectId(id)) return notFound(res);
    return res.json({ data: { count: await jobsService.countApplications(id) } });
  } catch (error) { next(error); }
};
