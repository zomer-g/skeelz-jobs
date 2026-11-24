/* ============================================================================
 *  Staff forward applications to the employer who owns the job (contentManagerOnly: content managers and admins;
 *  docs/employers.md "Applicants"). Nothing reaches an employer without one of these.
 *
 *    GET  /admin/employer-forwards?state=pending|forwarded|all&jobId&page&limit(≤100)
 *         applications (registered + quick) to jobs owned by an employer, with the forward state, ordered by
 *         employer and job ("ממתינות להעברה" = state=pending). Shows names → peopleHandover (staff budget).
 *    POST /admin/employer-forwards              { kind: 'application' | 'guest', applicationId }  "העברה למעסיק"
 *    POST /admin/employer-forwards/:id/cancel   "ביטול העברה": only while the employer has not been shown it
 *
 *  Logged with ids only: employer.applicant_forwarded (strict: no entry → the forward is withdrawn and refused),
 *  employer.forward_cancelled, employer.forward_cancel_refused (the employer already saw it — it can't be undone).
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import * as forwardDAL from '../dal/forwardDAL.js';
import { actorOf, writeAudit, writeAuditStrict } from '../security/audit.js';
import { mailForwarded } from '../mail/triggers.js';
import { peopleHandover } from '../security/handover.js';
import { isObjectId } from '../utils/ids.js';

const PLACE = 'GET /api/admin/employer-forwards';
const STATES = ['pending', 'forwarded', 'all'] as const;

const REFUSALS: Record<string, { status: number; message: string }> = {
  application_not_found: { status: 404, message: 'המועמדות לא נמצאה.' },
  no_employer: { status: 409, message: 'המשרה אינה של מעסיק עם חשבון (או שהועתקה מהאתר הקיים), ולכן אין למי להעביר.' },
  employer_inactive: { status: 409, message: 'חשבון המעסיק מושבת.' },
  window_closed: { status: 409, message: 'המשרה נסגרה לפני יותר מ-90 יום, ולכן אי אפשר להעביר אליה מועמדים.' },
  already_forwarded: { status: 409, message: 'המועמדות כבר הועברה למעסיק.' },
  forward_not_found: { status: 404, message: 'ההעברה לא נמצאה.' },
  forward_cancelled: { status: 409, message: 'ההעברה כבר בוטלה.' },
  forward_seen: { status: 409, message: 'המעסיק כבר צפה במועמדות, ולכן אי אפשר לבטל את ההעברה.' },
};
const refuse = (res: Response, code: string) => {
  const r = REFUSALS[code] ?? { status: 409, message: code };
  return res.status(r.status).json({ message: r.message, code });
};

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = (STATES as readonly string[]).includes(String(req.query.state)) ? (req.query.state as typeof STATES[number]) : 'pending';
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
    const jobId = typeof req.query.jobId === 'string' && isObjectId(req.query.jobId) ? req.query.jobId : undefined;
    let total = 0;
    const { rows, cut } = await peopleHandover({
      who: actorOf(req),
      action: 'candidates.shown',
      place: PLACE,
      details: { kind: 'employer_forwards', filters: { state, jobId }, page, limit },
      load: async () => { const r = await forwardDAL.listForStaff({ state, page, limit, jobId }); total = r.total; return r.rows; },
      idOf: (r) => r.candidateId,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { items: rows, total, cut, page, limit, state, pending: await forwardDAL.countPendingForStaff() } });
  } catch (e) { next(e); }
};

export const forward = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kind = String(req.body?.kind ?? '') as forwardDAL.ForwardKind;
    const applicationId = String(req.body?.applicationId ?? '');
    if (!forwardDAL.FORWARD_KINDS.includes(kind) || !isObjectId(applicationId)) {
      return res.status(400).json({ message: 'kind (application | guest) and applicationId are required', code: 'bad_request' });
    }
    const by = actorOf(req);
    const r = await forwardDAL.createForward(kind, applicationId, by);
    if (!r.ok) return refuse(res, r.code);
    const f = r.forward;
    try {
      // ids only: the forward, the application, the candidate, the job and the employer account.
      await writeAuditStrict(by, 'employer.applicant_forwarded', f.id, {
        kind: f.kind, application: f.applicationId, ids: [f.candidateId], job: f.jobId, employer: `user:${f.employerId}`,
      });
    } catch (e) {
      await forwardDAL.undoForward(f.id).catch(() => undefined);
      throw e;
    }
    // The candidate is told, and the employer invited to their area (each when its event is on; src/mail).
    void mailForwarded(f);
    return res.status(201).json({ data: { id: f.id, state: 'forwarded' } });
  } catch (e) { next(e); }
};

export const cancel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const by = actorOf(req);
    const r = await forwardDAL.cancelForward(id, by);
    if (!r.ok) {
      if (r.code === 'forward_seen') {
        const f = await forwardDAL.forwardById(id);
        void writeAudit(by, 'employer.forward_cancel_refused', id, {
          reason: 'seen', kind: f?.kind, application: f?.application_id, ids: f ? [f.candidate_id] : [], job: f?.job_id,
          employer: f ? `user:${f.employer_user_id}` : undefined,
        });
      }
      return refuse(res, r.code);
    }
    const f = r.forward;
    await writeAudit(by, 'employer.forward_cancelled', f.id, {
      kind: f.kind, application: f.applicationId, ids: [f.candidateId], job: f.jobId, employer: `user:${f.employerId}`,
    });
    return res.json({ data: { id: f.id, state: 'pending' } });
  } catch (e) { next(e); }
};
