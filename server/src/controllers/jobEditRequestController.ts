/* ============================================================================
 *  Employers' edit requests — the content managers' queue (/api/admin/job-edit-requests/*,
 *  contentManagerOnly; shown on the "משרות ממעסיקים" screen). Rules: docs/employers.md.
 *
 *  An employer asked to change one of their published jobs; the live job is
 *  unchanged until a content manager approves here. The screen compares, per
 *  field, the value when the employer asked (base), the job now (current) and
 *  the requested value. Approve → applied through jobsService.updateJobById
 *  (source 'screen'; Salesforce update only when ENABLE_SALESFORCE is on) and
 *  logged; reject → the job stays as it is, with an optional reason the
 *  employer sees. Jobs imported from the existing site are never changed
 *  (409 job_read_only from jobDAL.assertJobEditable).
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import * as employerDAL from '../dal/employerDAL.js';
import * as jobDAL from '../dal/jobDAL.js';
import { JobReadOnlyError } from '../middleware/errorMiddleware.js';
import * as jobsService from '../services/jobService.js';
import { actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { mailEditRequestDecision } from '../mail/triggers.js';
import { changesToJobUpdate, compareEditRequest, jobToEditable } from '../security/employer.js';
import { safeErrorText } from '../security/pure.js';
import { canManageContent } from '../models/enums.js';
import { CONTENT_MANAGER_REQUIRED } from '../security/roleFields.js';
import { cleanReason, descriptionToHtml } from '../services/jobSubmissionRules.js';
import * as customFields from '../services/customFieldsService.js';
import { asCustomValues, checkCustomValues, CustomValue } from '../models/schemas/customFields.js';

/** Requested answers to added job fields, as the review screen compares them (with labels). */
const extraComparison = async (changes: any, base: any, jobCustom: unknown) => {
  const asked = (changes?.customFields ?? {}) as Record<string, CustomValue | null>;
  if (!Object.keys(asked).length) return [];
  const defs = new Map((await customFields.definitionsOf('job')).map((d) => [d.id, d]));
  const cur = asCustomValues(jobCustom);
  return Object.entries(asked).map(([id, requested]) => ({
    field: `customFields.${id}`, label: defs.get(id)?.label ?? id, base: base?.customFields?.[id] ?? null, current: cur[id] ?? null,
    requested, changedSince: (base?.customFields?.[id] ?? null) !== (cur[id] ?? null),
  }));
};
/** Requested answers still valid now (a field turned off or an option removed since is dropped, never refused). */
const stillValid = async (asked: Record<string, CustomValue | null>): Promise<Record<string, CustomValue | null>> => {
  const defs = await customFields.definitionsOf('job');
  const out: Record<string, CustomValue | null> = {};
  for (const [id, v] of Object.entries(asked)) {
    const r = checkCustomValues(defs, { [id]: v === null ? '' : v });
    if (r.ok && id in r.values) out[id] = r.values[id];
  }
  return out;
};
const fieldNames = (changes: any) => Object.keys(changes ?? {}).flatMap((k) =>
  k === 'customFields' ? Object.keys(changes.customFields ?? {}).map((id) => `customFields.${id}`) : [k]);

const notPending = (res: Response) => res.status(409).json({ message: 'Not found or no longer pending', code: 'edit_not_pending' });

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (employerDAL.EDIT_STATUSES as string[]).includes(String(req.query.status))
      ? (req.query.status as employerDAL.EditRequestStatus) : 'pending';
    const r = await employerDAL.listEditRequests(status);
    void writeAudit(actorOf(req), 'jobs.edit_requests_listed', `status:${status}`, { count: r.items.length });
    return res.json({ data: { counts: r.counts, items: r.items.map((x) => ({ ...x, fields: fieldNames(x.changes) })) } });
  } catch (e) { next(e); }
};

export const get = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await employerDAL.getEditRequest(req.params.id);
    if (!r) return res.status(404).json({ message: 'Not found', code: 'edit_not_found' });
    const job = await jobDAL.findJobByJobId(r.jobId, { withComments: true });
    const current = job ? jobToEditable(job as any) : null;
    void writeAudit(actorOf(req), 'jobs.edit_request_viewed', r.id, { job: r.jobId, status: r.status });
    return res.json({
      data: {
        ...r,
        readOnly: !!(job as any)?.importedFromLive,
        jobStatus: job?.status ?? null,
        comparison: current ? [...compareEditRequest(r.changes, r.base, current), ...(await extraComparison(r.changes, r.base, (job as any)?.customFields))] : [],
      },
    });
  } catch (e) { next(e); }
};

export const approve = async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id;
  const who = actorOf(req);
  let claimed = false;
  try {
    const r = await employerDAL.getEditRequest(id);
    if (!r || r.status !== 'pending') return notPending(res);
    // A change of the threshold condition (set, changed or cleared) is approved by a content manager, not a coordinator.
    if ('thresholdCondition' in (r.changes ?? {}) && !canManageContent(req.authUser?.role)) {
      auditDenied(req, CONTENT_MANAGER_REQUIRED);
      return res.status(403).json({ message: 'משרה עם תנאי סף מאושרת על ידי מנהל תוכן', code: CONTENT_MANAGER_REQUIRED, fields: ['thresholdCondition'] });
    }
    claimed = await employerDAL.claimEditRequest(id, who, 'approved');
    if (!claimed) return notPending(res);
    const { customFields: askedExtra, ...std } = (r.changes ?? {}) as any;
    const update = changesToJobUpdate(std, descriptionToHtml);
    const job = await jobsService.updateJobById(r.jobId, update as any, 'screen'); // refuses an imported job (409)
    if (!job) throw new Error('job not found');
    if (askedExtra) await customFields.saveJobValues(r.jobId, await stillValid(askedExtra));
    const fields = fieldNames(r.changes);
    void writeAudit(who, 'jobs.edit_request_approved', id, { job: r.jobId, fields });
    void mailEditRequestDecision(r, { approved: true }); // the employer is told (when the event is on; src/mail)
    void writeAudit(who, 'job.updated', r.jobId, { fields: Object.keys(update), via: 'employer_request', request: id });
    return res.json({ data: { status: 'approved', jobId: r.jobId, fields } });
  } catch (e) {
    if (claimed) await employerDAL.releaseEditRequest(id).catch((x) => console.error('[edit-requests] release failed', safeErrorText(x)));
    if (e instanceof JobReadOnlyError) return next(e);
    console.error('[edit-requests] approve failed', safeErrorText(e));
    next(e);
  }
};

export const reject = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reason = cleanReason(req.body?.reason);
    const before = await employerDAL.getEditRequest(req.params.id);
    const ok = await employerDAL.claimEditRequest(req.params.id, actorOf(req), 'rejected', reason);
    if (!ok) return notPending(res);
    void writeAudit(actorOf(req), 'jobs.edit_request_rejected', req.params.id, { has_reason: !!reason });
    if (before) void mailEditRequestDecision(before, { approved: false, reason });
    return res.json({ data: { status: 'rejected' } });
  } catch (e) { next(e); }
};
