/* ============================================================================
 *  Guest (quick) applications for staff — content managers and admins (contentManagerOnly, routes.ts):
 *   GET  /api/admin/guest-applications                  ?page&limit(≤50)&jobId&unsent=true — through
 *                                                        peopleHandover (daily limit, strict log with the ids)
 *   GET  /api/admin/guest-applications/:id/cv           the CV the guest sent, through cvHandover
 *   POST /api/admin/guest-applications/salesforce-push  { limit? ≤ 50 } sends unsent ones to Salesforce
 *                                                        (409 while it is off); salesforce.pushed, strict, first
 *  Nothing here deletes or changes what the guest sent (services/guestApplications.ts).
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import { actorOf } from '../security/audit.js';
import { pushRecords } from '../services/salesforceSync.js';
import { cvHandover, peopleHandover } from '../security/handover.js';
import { isObjectId } from '../utils/ids.js';
import { getStoredFile } from '../services/s3Service.js';
import { forwardInfo } from '../dal/forwardDAL.js';
import {
  countUnsent, guestApplicationCvKey, listGuestApplications, salesforceOn, unsentGuestApplications,
} from '../services/guestApplications.js';

const PLACE = 'GET /api/admin/guest-applications';

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit)) || 20));
    const jobId = typeof req.query.jobId === 'string' && isObjectId(req.query.jobId) ? req.query.jobId : undefined;
    const unsentOnly = req.query.unsent === 'true';
    let total = 0;
    const { rows, cut } = await peopleHandover({
      who: actorOf(req),
      action: 'candidate.applications_viewed',
      place: PLACE,
      details: { kind: 'guest', filters: { jobId, unsent: unsentOnly || undefined }, page, limit },
      load: async () => { const r = await listGuestApplications({ page, limit, jobId, unsentOnly }); total = r.total; return r.rows; },
      idOf: (r) => r.id,
    });
    // Applications to a job an employer owns carry the forward state ("העברה למעסיק" / "ביטול העברה").
    const fwd = await forwardInfo('guest', rows.map((r) => r.id));
    const applications = rows.map((r) => ({ ...r, employerForward: fwd.get(r.id) ?? null }));
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { applications, total, cut, page, limit, salesforceEnabled: salesforceOn(), unsent: await countUnsent() } });
  } catch (e) { next(e); }
};

export const cv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!isObjectId(id)) return res.status(404).json({ message: 'Not found' });
    const key = await guestApplicationCvKey(id);
    if (!key) return res.status(404).json({ message: 'Not found' });
    const file = await cvHandover({
      who: actorOf(req), subjectId: id, place: `${PLACE}/:id/cv`,
      open: () => getStoredFile(key),
      abort: (f) => f.stream.destroy(),
      details: (f) => ({ type: f.contentType, kind: 'guest' }),
    });
    res.setHeader('Content-Type', file.contentType);
    if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    file.stream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
    file.stream.pipe(res);
  } catch (e) { next(e); }
};

export const pushToSalesforce = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!salesforceOn()) {
      return res.status(409).json({ message: 'Salesforce is turned off on this server (ENABLE_SALESFORCE). Nothing was sent.', code: 'salesforce_disabled' });
    }
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.body?.limit)) || 20));
    const rows = await unsentGuestApplications(limit);
    if (!rows.length) return res.json({ data: { pushed: 0, failed: 0, results: [] } });
    // Idempotent (salesforceSync.ts): a retry never makes a second Contact or Case. The strict log entry with the
    // guest ids is written there, before the first outbound call.
    const results = (await pushRecords(actorOf(req), 'guest_application', rows.map((r) => r.id),
      'POST /api/admin/guest-applications/salesforce-push')).map((r) => ({ id: r.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) }));
    res.json({ data: { pushed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results } });
  } catch (e) { next(e); }
};
