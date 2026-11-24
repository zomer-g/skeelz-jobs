/* ============================================================================
 *  Salesforce on the admin security screen (adminOnly, routes.ts). Ids, codes
 *  and metadata names only: no candidate field, no secret, no token.
 *   GET  /api/admin/security/salesforce            state: on/off, setting problems (names only), counts per kind,
 *                                                  recent failures (kind, record id, code), last check
 *   POST /api/admin/security/salesforce/check      connection check, READ ONLY (also while off)  → salesforce.checked
 *   POST /api/admin/security/salesforce/retry      { kind? } failed records back in the queue    → salesforce.retried
 *   GET  /api/admin/security/salesforce/legacy-jobs       the existing site's jobs: mode, last read, counts
 *   POST /api/admin/security/salesforce/legacy-jobs/run   { full? } read them from Salesforce now (mirror mode)  → legacy_jobs.mirrored
 *   GET  /api/admin/security/salesforce/legacy-candidates      the existing site's candidates: mode, last read, counts
 *   POST /api/admin/security/salesforce/legacy-candidates/run  { full? } read them now (mirror mode) → legacy_candidates.mirrored
 *   GET  /api/admin/security/salesforce/cutover-report    READ ONLY: Position Cases vs jobs here, candidates' matches  → salesforce.cutover_report
 *  retry: 409 salesforce_disabled while off. There is no "send the old ones": nothing from before the switch-on is
 *  sent (owner's rule, 11.2026). What actually leaves is logged by the worker
 *  (salesforce.pushed, strict, with the people's ids) before it is sent.
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import appConfig from '../config/appConfig.js';
import { SALESFORCE_ENV } from '../config/salesforceSettings.js';
import { actorOf, writeAudit } from '../security/audit.js';
import { lastCheckReport, runSalesforceCheck } from '../services/salesforceCheck.js';
import { isSyncKind, requeueFailed, syncSummary } from '../services/salesforceSync.js';
import { cutoverReport as buildCutoverReport, legacyJobsSummary, mirrorActive, runLegacyMirror } from '../services/legacyJobs.js';
import { candidatesMirrorActive, legacyCandidatesSummary, runCandidatesMirror } from '../services/legacyCandidates.js';

const off = (res: Response) => res.status(409).json({
  message: 'Salesforce is turned off on this server (ENABLE_SALESFORCE, or settings to fix). Nothing was sent.', code: 'salesforce_disabled',
});

export const status = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const s = appConfig.salesforce;
    const env = (process.env as Record<string, string | undefined>);
    res.json({
      data: {
        requested: s.requested,
        enabled: s.enableSalesforce,
        problems: s.problems,
        settings: SALESFORCE_ENV.map((v) => ({
          name: v.name, required: v.required, secret: v.secret, set: !!String(env[v.name] ?? '').trim(),
          // Ids and the URL are not secret; the client id and the secret are never shown.
          ...(!v.secret && v.name !== 'SALESFORCE_CLIENT_ID' && String(env[v.name] ?? '').trim() ? { value: String(env[v.name]).trim() } : {}),
        })),
        apiVersion: s.apiVersion,
        ...(await syncSummary()),
        lastCheck: lastCheckReport(),
      },
    });
  } catch (e) { next(e); }
};

let checking = false;
export const check = async (req: Request, res: Response, next: NextFunction) => {
  if (checking) return res.status(409).json({ message: 'A check is already running', code: 'check_running' });
  checking = true;
  try {
    const report = await runSalesforceCheck();
    void writeAudit(actorOf(req), 'salesforce.checked', null, { ok: report.ok, failed: report.items.filter((i) => !i.ok).map((i) => i.id) });
    res.json({ data: report });
  } catch (e) { next(e); }
  finally { checking = false; }
};

export const retry = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!appConfig.salesforce.enableSalesforce) return off(res);
    const kind = req.body?.kind;
    if (kind !== undefined && !isSyncKind(kind)) return res.status(400).json({ message: 'kind: job, candidate, employer, application, guest_application', code: 'bad_kind' });
    const count = await requeueFailed(kind);
    void writeAudit(actorOf(req), 'salesforce.retried', kind ?? null, { kind: kind ?? 'all', count });
    res.json({ data: { queued: count } });
  } catch (e) { next(e); }
};

export const legacyJobs = async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ data: await legacyJobsSummary() }); } catch (e) { next(e); }
};

/** Reads the existing site's jobs now. 409 when not mirroring (LEGACY_JOBS_MODE, or Salesforce off). */
export const runLegacyJobs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!mirrorActive()) {
      return res.status(409).json({ message: 'The existing site\'s jobs are not being mirrored (LEGACY_JOBS_MODE=mirror with Salesforce on).', code: 'legacy_mirror_off' });
    }
    const r = await runLegacyMirror({ full: req.body?.full === true, actor: actorOf(req) });
    if (!r.ran) return res.status(r.reason === 'already_running' ? 409 : 502).json({ message: 'The read did not complete', code: r.reason ?? 'error' });
    res.json({ data: { counts: r.counts, truncated: !!r.truncated } });
  } catch (e) { next(e); }
};

export const legacyCandidates = async (_req: Request, res: Response, next: NextFunction) => {
  try { res.json({ data: await legacyCandidatesSummary() }); } catch (e) { next(e); }
};

/** Reads the existing site's candidates now (counts and codes only). 409 when not mirroring. */
export const runLegacyCandidates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!candidatesMirrorActive()) {
      return res.status(409).json({ message: 'The existing site\'s candidates are not being mirrored (LEGACY_CANDIDATES_MODE=mirror with Salesforce on).', code: 'legacy_mirror_off' });
    }
    const r = await runCandidatesMirror({ full: req.body?.full === true, actor: actorOf(req) });
    if (!r.ran) return res.status(r.reason === 'already_running' ? 409 : 502).json({ message: 'The read did not complete', code: r.reason ?? 'error' });
    res.json({ data: { counts: r.counts, truncated: !!r.truncated } });
  } catch (e) { next(e); }
};

let reporting = false;
/** The cutover report: reads Salesforce (never writes), whenever the settings are complete (also while off). */
export const cutoverReport = async (req: Request, res: Response, next: NextFunction) => {
  if (!appConfig.salesforce.complete) return res.status(409).json({ message: 'Salesforce settings are incomplete', code: 'settings_incomplete' });
  if (reporting) return res.status(409).json({ message: 'A report is already running', code: 'report_running' });
  reporting = true;
  try {
    const report = await buildCutoverReport();
    void writeAudit(actorOf(req), 'salesforce.cutover_report', null, { jobsOk: !!(report.jobs as any).ok });
    res.json({ data: report });
  } catch (e) { next(e); }
  finally { reporting = false; }
};
