/* ============================================================================
 *  The employer's personal area (/api/employer/*, gate employerOnly).
 *  Rules: docs/employers.md.
 *
 *  Every handler works on the caller's own rows only: the user id comes from
 *  the session (req.authUser, DB role 'employer'), never from the path or body.
 *  Nothing here reads candidates, applications or CVs (the forwarded applicants are in
 *  employerApplicantsController.ts, through the hand-overs).
 *
 *    GET   /employer/me                         own details (+ how many earlier submissions can be claimed)
 *    PATCH /employer/me                         change own details (name, company, phone, job title)
 *    GET   /employer/submissions                own submissions: pending / approved / rejected
 *    POST  /employer/submissions/claim          claim earlier anonymous submissions sent with the account's
 *                                               verified sign-in email as the contact email
 *    GET   /employer/jobs                       own published jobs (status, publish date, pending request)
 *    GET   /employer/jobs/:jobId                one own job as the edit form shows it (plain text)
 *    POST  /employer/jobs/:jobId/edit-requests  ask for a change: stored as pending, the live job is unchanged
 *    GET   /employer/edit-requests              own edit requests and their outcome
 *    POST  /employer/edit-requests/:id/withdraw withdraw an own pending request
 * ========================================================================== */
import { queueSalesforce } from '../services/salesforceSync.js';
import { NextFunction, Request, Response } from 'express';
import { query } from '../config/db.js';
import * as employerDAL from '../dal/employerDAL.js';
import * as jobDAL from '../dal/jobDAL.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { checkEditRequest, checkEmployerProfile, jobToEditable } from '../security/employer.js';
import { safeErrorText } from '../security/pure.js';
import { syncEmployerLater } from '../services/employerAccounts.js';
import { cleanReason } from '../services/jobSubmissionRules.js';
import { isObjectId } from '../utils/ids.js';
import * as customFields from '../services/customFieldsService.js';
import { asCustomValues, changedValues, checkCustomValues, CustomValue, errorCodesOf } from '../models/schemas/customFields.js';

/** Added job fields an employer's edit request covers: active ones shown on the job page (their answers are public
 *  anyway). Staff-only fields are asked in the employer form for a NEW job, but their answers are never shown back to
 *  an employer (staff may keep notes there). */
const editableJobFields = async () => (await customFields.definitionsOf('job')).filter((d) => d.active && d.showOnJobPage);
const activeJobValues = async (stored: unknown): Promise<Record<string, CustomValue>> => {
  const ids = new Set((await editableJobFields()).map((d) => d.id));
  return Object.fromEntries(Object.entries(asCustomValues(stored)).filter(([k]) => ids.has(k)));
};

const me = (req: Request) => req.authUser!.id; // set by employerOnly from the DB (role 'employer')
const noStore = (res: Response) => res.setHeader('Cache-Control', 'private, no-store');
const notFound = (res: Response) => res.status(404).json({ message: 'Job not found', code: 'job_not_found' });
const readOnly = (res: Response) => res.status(409).json({
  message: 'המשרה הועתקה מהאתר הקיים ולכן לקריאה בלבד כאן. לשינויים פנו לצוות SKEELZ.', code: 'job_read_only',
});

/** Checks that refs in the requested values exist (city, skills) — the same check as the public form. */
const checkReferences = async (changes: Record<string, any>): Promise<Record<string, string>> => {
  const errors: Record<string, string> = {};
  if (changes.citySymbol !== undefined && !(await query(`SELECT 1 FROM locations WHERE city_symbol = $1`, [changes.citySymbol])).length) {
    errors.citySymbol = 'invalid';
  }
  if (changes.requiredSkills?.length) {
    const r = await query(`SELECT id FROM skills WHERE id = ANY($1::text[])`, [changes.requiredSkills]);
    if (r.length !== changes.requiredSkills.length) errors.requiredSkills = 'invalid';
  }
  return errors;
};

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const e = await employerDAL.getEmployer(me(req));
    if (!e) return res.status(404).json({ message: 'Not an employer account', code: 'not_employer' });
    noStore(res);
    return res.json({ data: { ...e, claimable: await employerDAL.claimableCount(e.email) } });
  } catch (e) { next(e); }
};

export const updateMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter((k) => !['firstName', 'lastName', 'companyName', 'phone', 'jobTitle'].includes(k));
    if (unknown.length) return res.status(400).json({ message: 'not editable here', code: 'bad_field', fields: unknown.slice(0, 10) });
    const check = checkEmployerProfile(body);
    if (!check.ok) return res.status(400).json({ message: 'Some fields are missing or invalid', code: 'employer_invalid', fields: check.bad });
    const fields = Object.keys(check.values);
    if (!fields.length) return res.status(400).json({ message: 'Nothing to change', code: 'no_changes' });
    const e = await employerDAL.updateEmployer(me(req), check.values);
    if (!e) return res.status(404).json({ message: 'Not an employer account', code: 'not_employer' });
    void writeAudit(actorOf(req), 'employer.profile_updated', 'self', { fields });
    syncEmployerLater(me(req), actorOf(req));
    noStore(res);
    return res.json({ data: e });
  } catch (e) { next(e); }
};

export const submissions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    noStore(res);
    return res.json({ data: { items: await employerDAL.ownSubmissions(me(req)) } });
  } catch (e) { next(e); }
};

/** Earlier anonymous submissions → this account, only when their contact email is the account's sign-in email
 *  (verified by Google, Microsoft or the code by email). Unowned ones only; never another account's. */
export const claim = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await employerDAL.claimSubmissions(me(req), req.authUser!.email);
    void writeAudit(actorOf(req), 'employer.submissions_claimed', 'self', { count: r.ids.length, jobs: r.jobs, ids: r.ids.slice(0, 100) });
    for (const jobId of r.jobIds) void queueSalesforce('job', jobId); // their Cases point at the employer's Contact (off → nothing)
    return res.json({ data: { claimed: r.ids.length, jobs: r.jobs } });
  } catch (e) { next(e); }
};

export const jobs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    noStore(res);
    return res.json({ data: { items: await employerDAL.ownJobs(me(req)) } });
  } catch (e) { next(e); }
};

/** One own job as the edit form shows it. A job imported from the existing site comes back with readOnly. */
export const job = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.jobId;
    if (!isObjectId(id) || !(await employerDAL.ownsJob(me(req), id))) return notFound(res);
    const j = await jobDAL.findJobByJobId(id, { withComments: true }); // read in full here; only jobToEditable's fields are sent
    if (!j) return notFound(res);
    const pending = (await employerDAL.ownEditRequests(me(req))).find((r) => r.jobId === id && r.status === 'pending') ?? null;
    noStore(res);
    return res.json({
      data: {
        id: j._id, jobId: j.jobId, status: j.status, publishDate: j.publishDate, readOnly: !!(j as any).importedFromLive,
        values: { ...jobToEditable(j as any), customFields: await activeJobValues((j as any).customFields) }, pendingRequest: pending,
      },
    });
  } catch (e) { next(e); }
};

/** An edit request: stored as pending; the public job stays exactly as it is until a content manager approves. */
export const requestEdit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.jobId;
    // Ownership first: someone else's job (or no job) is 404 whatever it is, so the answer says nothing about it.
    if (!isObjectId(id) || !(await employerDAL.ownsJob(me(req), id))) return notFound(res);
    // Imported from the existing site: read-only here for everyone (jobs-management.md), so never an edit request.
    const imported = await query<{ imported_from_live: boolean }>(`SELECT imported_from_live FROM jobs WHERE id = $1`, [id]);
    if (imported[0]?.imported_from_live) return readOnly(res);
    const j = await jobDAL.findJobByJobId(id, { withComments: true }); // read in full here; only jobToEditable's fields are sent
    if (!j) return notFound(res);
    if ((j as any).deletedAt) return res.status(409).json({ message: 'The job was removed from the board', code: 'job_archived' });
    const current = jobToEditable(j as any);
    const { customFields: rawExtra, ...body } = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    // The added job fields (settings screen): the same rules as the employer form; only changed answers are asked for.
    let extraChanges: Record<string, CustomValue | null> = {};
    if (rawExtra !== undefined) {
      const defs = await editableJobFields(); // any other field id is dropped (allowlist)
      const r = checkCustomValues(defs, rawExtra);
      if (!r.ok) return res.status(400).json({ message: 'Some fields are missing or invalid', code: 'submission_invalid', fields: errorCodesOf(defs, rawExtra, r.bad) });
      extraChanges = changedValues((j as any).customFields, r.values);
    }
    const extraIds = Object.keys(extraChanges);
    const check = checkEditRequest(body, current);
    if (!check.ok) {
      const e = check.errors as Record<string, string>;
      if (e._ === 'bad_field') return res.status(400).json({ message: 'not editable', code: 'bad_field', fields: check.badFields });
      if (e._ === 'no_changes' && !extraIds.length) return res.status(400).json({ message: 'Nothing was changed', code: 'no_changes' });
      if (e._ !== 'no_changes') return res.status(400).json({ message: 'Some fields are missing or invalid', code: 'submission_invalid', fields: e });
    }
    const std = check.ok ? check : { changes: {}, fields: [] as string[] };
    const refErrors = await checkReferences(std.changes);
    if (Object.keys(refErrors).length) return res.status(400).json({ message: 'Some fields are missing or invalid', code: 'submission_invalid', fields: refErrors });
    const base: Record<string, unknown> = {};
    for (const f of std.fields) base[f] = (current as any)[f];
    const changes: Record<string, unknown> = { ...std.changes };
    if (extraIds.length) {
      const cur = asCustomValues((j as any).customFields);
      changes.customFields = extraChanges;
      base.customFields = Object.fromEntries(extraIds.map((k) => [k, cur[k] ?? null]));
    }
    const fields = [...std.fields, ...extraIds.map((k) => `customFields.${k}`)];
    const rid = await employerDAL.createEditRequest(id, me(req), changes as any, base as any, cleanReason(body.note));
    if (!rid) return res.status(409).json({ message: 'A change to this job is already waiting for review', code: 'edit_pending' });
    // Field names only — never the values.
    void writeAudit(actorOf(req), 'jobs.edit_requested', rid, { job: id, fields });
    return res.status(201).json({ data: { id: rid, status: 'pending', fields } });
  } catch (e) {
    console.error('[employer] edit request failed', safeErrorText(e));
    next(e);
  }
};

export const editRequests = async (req: Request, res: Response, next: NextFunction) => {
  try {
    noStore(res);
    return res.json({ data: { items: await employerDAL.ownEditRequests(me(req)) } });
  } catch (e) { next(e); }
};

export const withdraw = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await employerDAL.withdrawEditRequest(req.params.id, me(req));
    if (!ok) return res.status(409).json({ message: 'Not found or no longer pending', code: 'edit_not_pending' });
    void writeAudit(actorOf(req), 'jobs.edit_withdrawn', req.params.id, null);
    return res.json({ data: { status: 'withdrawn' } });
  } catch (e) { next(e); }
};
