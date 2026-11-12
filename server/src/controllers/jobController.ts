import { NextFunction, Request, Response } from 'express';
import * as jobsService from '../services/jobService.js';
import * as jobApplicationService from '../services/jobApplicationService.js';
import { AxiosError, isAxiosError } from 'axios';
import { AuthErrorCodes, AuthErrorMessages, JobsErrorCodes, JobsErrorMessages } from '../i18n/i18n.js';
import { filterOptions } from '../models/interfaces/general.interface.js';
import { CreateJobDTO } from '../dto/createJobDto.js';
import { UpdateJobDto } from '../dto/updateJobDto.js';
import { UserRole } from '../models/enums.js';
import { AuditWriteError, actorOf, writeAudit } from '../security/audit.js';
import { peopleHandover } from '../security/handover.js';
import { LimitError } from '../middleware/errorMiddleware.js';
import { safeErrorText } from '../security/pure.js';
import { checkPublishDate, isOpenByLink } from '../models/schemas/jobBoard.js';
import { isObjectId } from '../utils/ids.js';

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
  try {
    const created: any = await jobsService.createJob(createJobDTO);
    void writeAudit(actorOf(req), 'job.created', created?._id ? String(created._id) : null, {
      title: String(createJobDTO?.title ?? '').slice(0, 200), fields: Object.keys(createJobDTO ?? {}).filter((k) => (createJobDTO as any)[k] !== undefined).slice(0, 30),
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

    const updatedJob = await jobsService.updateJobById(jobId, updateJobDto);

    if (updatedJob) {
      void writeAudit(actorOf(req), 'job.updated', String(updatedJob._id), { fields: Object.keys(updateJobDto ?? {}).filter((k) => (updateJobDto as any)[k] !== undefined).slice(0, 30) });
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
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(JobsErrorMessages.UPDATE_JOB_FAILED, JobsErrorCodes.UPDATE_JOB_FAILED));
  }
};

export const fetchJobById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = req.params.jobId ?? "";
    // Internal comments are for content managers only (they used to be public).
    const isContentManager = req.authJwtPayload?.userRole === UserRole.CONTENT_MANAGER;
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
    if (userRole !== UserRole.CONTENT_MANAGER && userID !== userId) {
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

export const applyJob = async (req: Request, res: Response, next: NextFunction) => {
  const { userID } = req.authJwtPayload!;
  const jobIdNumber = req.params.jobId;

  try {
    // body.cv: which CV goes with this application (services/applicationCv.ts).
    const result = await jobApplicationService.addJobApplication(userID, jobIdNumber, req.body?.cv);
    void writeAudit(actorOf(req), 'job.applied', String(jobIdNumber));
    return res.json({ data: {message: 'Application submitted successfully', ...result}});
  } catch (error) {
    if (isAxiosError(error)) {
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
  // The answer is the same whether or not the email has an account (it used to
  // answer "user exists", which told anyone who is registered). An application
  // with a registered email is taken as a guest application like any other.
  try {
    await jobApplicationService.guestApplyJob(jobData, guestApplication);
    void writeAudit(`anonymous:${req.ip}`, 'guest.applied', String(jobData?._id ?? ''), { has_cv: !!guestApplication?.cvFilePath });
    return res.json({ data: { message: 'Application submitted successfully' } });
  } catch (error) {
    if (isAxiosError(error)) {
      return next(error);
    }
    next(new AxiosError(JobsErrorMessages.APPLY_JOB, JobsErrorCodes.APPLY_JOB));
  }
};

// ---- jobs-management screen (content managers; docs/jobs-management.md) ----

const notFound = (res: Response) => res.status(404).json({ data: null, message: 'Job not found' });
const jobIdOf = (req: Request) => String(req.params.jobId ?? '');

/** POST /admin/jobs/:jobId/pin — bump to the top of the public board (again = above the other pins). */
export const pinJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    const job = await jobsService.setPinned(id, true);
    if (!job) return notFound(res);
    void writeAudit(actorOf(req), 'job.pinned', id, { fields: ['pinnedAt'] });
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
const BOARD_FIELDS = ['isPublic', 'isSponsored', 'publishDate', 'status', 'quickApplyOverride', 'quickApplyWithoutCvOverride'] as const;
const STATUSES = ['Active', 'Suspended', 'Closed'];

/** PATCH /admin/jobs/:jobId/board — inline edits from the list (visibility, crown, publish date, status,
 *  apply-policy overrides). Strict allowlist; field names only in the log. */
export const updateJobBoard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = jobIdOf(req);
    if (!isObjectId(id)) return notFound(res);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter((k) => !(BOARD_FIELDS as readonly string[]).includes(k) && k !== 'schedulePublish');
    if (unknown.length) return res.status(400).json({ message: `not editable here: ${unknown.slice(0, 5).join(', ')}`, code: 'bad_field' });
    const dto: Record<string, any> = { ...body };
    for (const k of ['isPublic', 'isSponsored']) {
      if (k in dto && typeof dto[k] !== 'boolean') return res.status(400).json({ message: `${k}: true or false`, code: 'bad_value' });
    }
    for (const k of ['quickApplyOverride', 'quickApplyWithoutCvOverride']) {
      if (k in dto && dto[k] !== null && typeof dto[k] !== 'boolean') return res.status(400).json({ message: `${k}: true, false or null`, code: 'bad_value' });
    }
    if ('status' in dto && !STATUSES.includes(dto.status)) return res.status(400).json({ message: 'status: Active, Suspended or Closed', code: 'bad_value' });
    const dateError = takePublishDate(dto);
    if (dateError) return badDate(res, dateError);
    const fields = Object.keys(dto);
    if (!fields.length) return res.status(400).json({ message: 'nothing to change', code: 'bad_value' });
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
