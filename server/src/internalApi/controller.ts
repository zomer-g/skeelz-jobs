/* ============================================================================
 *  Internal API handlers (/api/internal/v1). Every caller is req.apiClient (a
 *  token or the server secret, set by internalApiAuth) and is the actor in the
 *  activity log. People leave only through peopleHandover / cvHandover, so the
 *  daily limits, strict log entries and alerts apply to tokens as to admins.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import * as jobsService from '../services/jobService.js';
import { getStoredFile } from '../services/s3Service.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { cvHandover, peopleHandover } from '../security/handover.js';
import { isObjectId } from '../utils/ids.js';
import { JobStatus } from '../models/enums.js';
import { takePublishDate, takeThresholdCondition } from '../controllers/jobController.js';
import { SCREEN_ONLY_FIELDS } from '../models/schemas/jobBoard.js';
import { getApplication, getCandidate, candidateCvKey, listApplications, listCandidates, paging, parseSince } from './data.js';
import { SyncKind, isSyncKind, pendingIds, pushRecords, salesforceEnabled, syncState } from './salesforcePush.js';
import { isAuthErrorCode } from './pure.js';

const bad = (res: Response, message: string, status = 400, code = 'bad_request') => res.status(status).json({ message, code });
const notFound = (res: Response) => bad(res, 'Not found', 404, 'not_found');
const place = (req: Request) => `${req.method} /api/internal/v1${req.route?.path ?? req.path}`;


// ---- jobs ----
const STATUSES = Object.values(JobStatus) as string[];

export const listJobs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = paging({ ...req.query, limit: req.query.limit ?? 50 });
    const status = String(req.query.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (status.some((s) => !STATUSES.includes(s))) return bad(res, `status: ${STATUSES.join(', ')}`);
    // Archived (soft-deleted) jobs are left out unless asked for: archived=include|only.
    const archived = req.query.archived === 'include' || req.query.archived === 'only' ? req.query.archived : undefined;
    const { jobs, total } = await jobsService.fetchAllJobs({
      page, limit, ...(status.length ? { jobStatus: status } : {}), ...(archived ? { archived } : {}), sortField: 'updatedAt', sortOrder: 'desc',
    } as any);
    void writeAudit(actorOf(req), 'jobs.internal_listed', place(req), { count: jobs.length, total, page });
    res.json({ data: { jobs, total, page, limit } });
  } catch (e) { next(e); }
};

export const getJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await jobsService.fetchJobById(String(req.params.id), { withComments: true });
    if (!job) return notFound(res);
    res.json({ data: job });
  } catch (e) { next(e); }
};

export const createJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Pin / bump / archive are set only on the jobs-management screen (docs/jobs-management.md).
    for (const f of SCREEN_ONLY_FIELDS) delete req.body?.[f];
    const dateError = takePublishDate(req.body, true);
    if (dateError) return bad(res, `publishDate: ${dateError}`, 400, `publish_date_${dateError}`);
    const thresholdError = takeThresholdCondition(req.body);
    if (thresholdError) return bad(res, `thresholdCondition: ${thresholdError}`, 400, `threshold_condition_${thresholdError}`);
    const job: any = await jobsService.createJob(req.body, 'integration');
    void writeAudit(actorOf(req), 'job.created', String(job?._id ?? ''), { title: String(req.body?.title ?? '').slice(0, 200), via: 'internal_api' });
    res.status(201).json({ data: job });
  } catch (e) { next(e); }
};

export const updateJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!isObjectId(id)) return notFound(res);
    const dateError = takePublishDate(req.body);
    if (dateError) return bad(res, `publishDate: ${dateError}`, 400, `publish_date_${dateError}`);
    const thresholdError = takeThresholdCondition(req.body);
    if (thresholdError) return bad(res, `thresholdCondition: ${thresholdError}`, 400, `threshold_condition_${thresholdError}`);
    // An integration never overwrites what a content manager set on the jobs-management screen.
    const r = await jobsService.updateJobByIdDetailed(id, req.body, 'integration');
    if (!r?.job) return notFound(res);
    const fields = Object.keys(req.body ?? {}).filter((f) => req.body[f] !== undefined && !r.ignored.includes(f)).slice(0, 30);
    void writeAudit(actorOf(req), 'job.updated', id, { fields, ignored: r.ignored, via: 'internal_api' });
    res.json({ data: r.job, ignored: r.ignored });
  } catch (e) { next(e); }
};

// ---- candidates ----
export const listCandidatesH = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pg = paging(req.query);
    const updatedSince = parseSince(req.query.updatedSince);
    if (updatedSince === null) return bad(res, 'updatedSince: an ISO date');
    const hasCv = req.query.hasCv === 'true' ? true : req.query.hasCv === 'false' ? false : undefined;
    const search = String(req.query.search ?? '').slice(0, 100) || undefined;
    let total = 0;
    const { rows, cut } = await peopleHandover({
      who: actorOf(req), budgetOwner: req.apiClient?.budgetOwner, action: 'candidates.shown', place: place(req),
      details: { filters: { search: search ? true : undefined, hasCv, updatedSince: updatedSince?.toISOString() }, page: pg.page, limit: pg.limit },
      load: async () => { const r = await listCandidates({ search, hasCv, updatedSince, ...pg }); total = r.total; return r.rows; },
      idOf: (c) => c.id,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { candidates: rows, total, cut, page: pg.page, limit: pg.limit } });
  } catch (e) { next(e); }
};

export const getCandidateH = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let found = true;
    const { rows } = await peopleHandover({
      who: actorOf(req), budgetOwner: req.apiClient?.budgetOwner, action: 'candidates.shown', place: place(req), details: { subject: String(req.params.id).slice(0, 40) },
      load: async () => { const c = await getCandidate(String(req.params.id)); found = !!c; return c ? [c] : []; },
      idOf: (c) => c.id,
    });
    if (!found) return notFound(res);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: rows[0] });
  } catch (e) { next(e); }
};

// ---- applications ----
const stripKey = <T extends { cvKey?: string }>(a: T) => { const { cvKey, ...rest } = a; return rest; };

export const listApplicationsH = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pg = paging(req.query);
    const since = parseSince(req.query.since);
    if (since === null) return bad(res, 'since: an ISO date');
    const jobId = req.query.jobId ? String(req.query.jobId) : undefined;
    const candidateId = req.query.candidateId ? String(req.query.candidateId) : undefined;
    if ((jobId && !isObjectId(jobId)) || (candidateId && !isObjectId(candidateId))) return bad(res, 'jobId / candidateId: 24-hex ids');
    let total = 0;
    const { rows, cut } = await peopleHandover({
      who: actorOf(req), budgetOwner: req.apiClient?.budgetOwner, action: 'candidate.applications_viewed', place: place(req),
      details: { filters: { jobId, candidateId, since: since?.toISOString() }, page: pg.page, limit: pg.limit },
      load: async () => { const r = await listApplications({ jobId, candidateId, since, ...pg }); total = r.total; return r.rows; },
      idOf: (a) => a.candidateId,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { applications: rows, total, cut, page: pg.page, limit: pg.limit } });
  } catch (e) { next(e); }
};

export const getApplicationH = async (req: Request, res: Response, next: NextFunction) => {
  try {
    let found = true;
    const { rows } = await peopleHandover({
      who: actorOf(req), budgetOwner: req.apiClient?.budgetOwner, action: 'candidate.applications_viewed', place: place(req), details: { application: String(req.params.id).slice(0, 40) },
      load: async () => { const a = await getApplication(String(req.params.id)); found = !!a; return a ? [stripKey(a)] : []; },
      idOf: (a) => a.candidateId,
    });
    if (!found) return notFound(res);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: rows[0] });
  } catch (e) { next(e); }
};

// ---- CV files (cvHandover: daily CV limit, strict entry before the file is sent) ----
const sendCv = async (req: Request, res: Response, subjectId: string, key: string) => {
  const file = await cvHandover({
    who: actorOf(req), budgetOwner: req.apiClient?.budgetOwner, subjectId, place: place(req),
    open: () => getStoredFile(key),
    abort: (f) => f.stream.destroy(),
    details: (f) => ({ type: f.contentType }),
  });
  res.setHeader('Content-Type', file.contentType);
  if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  file.stream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
  file.stream.pipe(res);
};

export const applicationCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = await getApplication(String(req.params.id));
    if (!a || !a.cvKey) return notFound(res);
    await sendCv(req, res, a.candidateId, a.cvKey);
  } catch (e) { next(e); }
};

export const candidateCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const key = await candidateCvKey(id);
    if (!key) return notFound(res);
    await sendCv(req, res, id, key);
  } catch (e) { next(e); }
};

// ---- Salesforce ----
/** 409 while ENABLE_SALESFORCE is off: nothing is sent anywhere. */
export const requireSalesforce = (_req: Request, res: Response, next: NextFunction) => {
  if (!salesforceEnabled()) {
    return res.status(409).json({ message: 'Salesforce is turned off on this server (ENABLE_SALESFORCE). Nothing was sent.', code: 'salesforce_disabled' });
  }
  next();
};

const pushOne = (kind: SyncKind) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!isObjectId(id)) return notFound(res);
    const [r] = await pushRecords(actorOf(req), kind, [id], place(req));
    if (r.error === 'not_found') return notFound(res);
    res.status(r.ok ? 200 : 502).json({ data: r });
  } catch (e) { next(e); }
};
export const pushJob = pushOne('job');
export const pushApplication = pushOne('application');
export const pushCandidate = pushOne('candidate');

export const pushPending = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kinds: SyncKind[] = Array.isArray(req.body?.kinds) && req.body.kinds.length ? req.body.kinds : ['job', 'candidate', 'application'];
    if (!kinds.every(isSyncKind)) return bad(res, 'kinds: job, candidate, application');
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.body?.limit)) || 50));
    const results = [];
    let left = limit;
    // Jobs and candidates before applications (an application Case points at both).
    for (const kind of (['job', 'candidate', 'application'] as SyncKind[]).filter((k) => kinds.includes(k))) {
      if (left <= 0) break;
      const ids = await pendingIds(kind, left);
      const r = await pushRecords(actorOf(req), kind, ids, place(req));
      results.push(...r);
      left -= r.length;
      if (r.some((x) => isAuthErrorCode(x.error))) break;
    }
    res.json({ data: { pushed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results } });
  } catch (e) { next(e); }
};

export const getSyncState = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : undefined;
    if (kind && !isSyncKind(kind)) return bad(res, 'kind: job, candidate, application');
    const status = req.query.status === 'error' || req.query.status === 'synced' ? req.query.status : undefined;
    const { limit, offset, page } = paging({ ...req.query, limit: req.query.limit ?? 50 });
    const { rows, pending } = await syncState({ kind: kind as SyncKind | undefined, status, limit, offset });
    res.json({ data: { enabled: salesforceEnabled(), pending, records: rows, page, limit } });
  } catch (e) { next(e); }
};

