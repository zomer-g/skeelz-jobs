/* ============================================================================
 *  Applicants the SKEELZ team forwarded to an employer (gate employerOnly; docs/employers.md "Applicants").
 *
 *    GET /employer/applicants[?jobId=]         the forwarded applicants of own jobs: name + forward date + whether
 *                                              there is a CV, grouped by job. Through peopleHandover (the
 *                                              employer's own budget employerPeople, strict log with the ids
 *                                              BEFORE the answer). A jobId that is not theirs → 404.
 *    GET /employer/applicants/:forwardId/cv    that applicant's CV, through cvHandover (budget employerCvs).
 *
 *  The employer id comes from the session (req.authUser, DB role 'employer'); visibility (own, live forward,
 *  not imported, 90-day window) is decided in SQL (dal/forwardDAL.ts). Nothing else about the candidate leaves:
 *  no email, phone, city, candidate id or application id — the forward id is the only handle.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import * as forwardDAL from '../dal/forwardDAL.js';
import { actorOf } from '../security/audit.js';
import { cvHandover, peopleHandover } from '../security/handover.js';
import { employerAccessUntil } from '../security/pure.js';
import { getStoredFile } from '../services/s3Service.js';
import { isObjectId } from '../utils/ids.js';

const me = (req: Request) => req.authUser!.id;
const PLACE = 'GET /api/employer/applicants';
const notFound = (res: Response) => res.status(404).json({ message: 'Not found', code: 'not_found' });

class ForwardGone extends Error {}
/** The employer's daily budgets belong to the account (user:<id>), never to how it signed in. */
const employerBudgetOwner = (req: Request) => `user:${me(req)}`;

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = typeof req.query.jobId === 'string' && req.query.jobId ? req.query.jobId : undefined;
    // Someone else's job (or no job, or an imported one) is the same 404, before anything is read or logged.
    if (jobId !== undefined && !(await forwardDAL.ownsForwardableJob(me(req), jobId))) return notFound(res);
    const { rows, cut } = await peopleHandover({
      who: actorOf(req),
      // One employer budget per ACCOUNT, whatever the session (several roles per account: an employer who is also
      // staff is logged by email on a Google session and as user:<id> otherwise; the budget stays the same).
      budgetOwner: employerBudgetOwner(req),
      action: 'employer.applicants_shown',
      budget: 'employerPeople',
      place: PLACE,
      details: jobId ? { job: jobId } : undefined,
      load: () => forwardDAL.visibleForwards(me(req), jobId),
      idOf: (r) => r.candidateId,
    });
    // Shown now → can no longer be cancelled. A forward cancelled between the read and this mark is dropped.
    const live = await forwardDAL.markSeen(me(req), rows.map((r) => r.forwardId));
    const shown = rows.filter((r) => live.has(r.forwardId));
    const jobs = new Map<string, { jobId: string; jobNumber: number; title: string; active: boolean; accessUntil: Date | null; applicants: unknown[] }>();
    for (const r of shown) {
      let j = jobs.get(r.jobId);
      if (!j) {
        const until = employerAccessUntil({ status: r.jobActive ? 'Active' : 'Closed' }, r.inactiveSince);
        j = { jobId: r.jobId, jobNumber: r.jobNumber, title: r.jobTitle, active: r.jobActive, accessUntil: until === 'closed' ? null : until, applicants: [] };
        jobs.set(r.jobId, j);
      }
      // The whole applicant, as the employer gets it: nothing else is added anywhere.
      j.applicants.push({ forwardId: r.forwardId, name: r.name, forwardedAt: r.forwardedAt, hasCv: r.hasCv });
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: { jobs: [...jobs.values()], cut } });
  } catch (e) { next(e); }
};

export const cv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const forwardId = String(req.params.forwardId);
    if (!isObjectId(forwardId)) return notFound(res);
    let file;
    try {
      file = await cvHandover({
        who: actorOf(req),
        budgetOwner: employerBudgetOwner(req),
        budget: 'employerCvs',
        subjectId: forwardId, // replaced below by the candidate id once the forward is resolved
        place: `${PLACE}/:forwardId/cv`,
        open: async () => {
          const f = await forwardDAL.openForwardCv(me(req), forwardId);
          if (!f || !f.cvKey) throw new ForwardGone();
          const stored = await getStoredFile(f.cvKey);
          return { ...stored, candidateId: f.candidateId, kind: f.kind, jobId: f.jobId };
        },
        abort: (f) => f.stream.destroy(),
        subject: (f) => f.candidateId,
        details: (f) => ({ type: f.contentType, kind: f.kind, job: f.jobId, forward: forwardId }),
      });
    } catch (e) {
      if (e instanceof ForwardGone) return notFound(res);
      throw e;
    }
    // Logged → now it counts as seen (no longer cancellable). Cancelled in the meantime → nothing is sent.
    const live = await forwardDAL.markSeen(me(req), [forwardId]).catch((e) => { file.stream.destroy(); throw e; });
    if (!live.has(forwardId)) { file.stream.destroy(); return notFound(res); }
    // A neutral file name: the stored one could carry something about the candidate.
    const ext = file.contentType === 'application/pdf' ? 'pdf' : file.fileName.toLowerCase().endsWith('.doc') ? 'doc' : 'docx';
    res.setHeader('Content-Type', file.contentType);
    if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength));
    res.setHeader('Content-Disposition', `attachment; filename="cv.${ext}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    file.stream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    file.stream.pipe(res);
  } catch (e) { next(e); }
};
