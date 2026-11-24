/* ============================================================================
 *  GET /api/internal/export  — a copy of this database for a SANDBOX channel.
 *
 *  Off unless SANDBOX_EXPORT_TOKEN (secret, >= 32 chars) is set; then it needs
 *  "Authorization: Bearer <token>". Answers 404 when off or on a wrong token,
 *  so the route is invisible.
 *
 *  Personal data never leaves prod as-is: users are anonymized here (name,
 *  email, phone, birth date, CV link), password hashes are dropped. Login
 *  tokens and pending uploads are not exported. The sandbox makes its own admin
 *  (bootstrapAdmin) and test users.
 * ========================================================================== */
import crypto from 'crypto';
import { Request, Response } from 'express';
import { query } from '../config/db.js';
import { importFromProd } from '../scripts/importFromProd.js';
import { AuditWriteError, actorOf, writeAudit, writeAuditStrict } from '../security/audit.js';
import { safeErrorText } from '../security/pure.js';
import { jobsChanged } from '../services/jobsCache.js';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

export const isSandbox = () => process.env.SANDBOX === 'true';

/* POST /api/internal/sandbox-refresh — admin only (routes.ts), sandbox only (404 elsewhere).
 * Replaces the sandbox's data with a fresh copy of prod's; one run at a time. */
let refreshing = false;
export const refreshSandbox = async (req: Request, res: Response): Promise<void> => {
  if (!isSandbox()) { res.status(404).json({ message: 'Not found' }); return; }
  if (refreshing) { res.status(409).json({ message: 'A refresh is already running' }); return; }
  refreshing = true;
  try {
    const result = await importFromProd();
    jobsChanged();
    void writeAudit(actorOf(req), 'sandbox.refreshed', null, { counts: result?.counts });
    res.json({ data: result });
  } catch (e) {
    // Neither the answer nor the console carries raw error text (it may hold a URL, a host or data).
    console.error('[sandbox] refresh failed:', safeErrorText(e));
    res.status(502).json({ message: 'Copy from prod failed', code: 'sandbox_refresh_failed' });
  } finally {
    refreshing = false;
  }
};

export const exportForSandbox = async (req: Request, res: Response): Promise<void> => {
  const expected = process.env.SANDBOX_EXPORT_TOKEN || '';
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (expected.length < 32 || !given || !crypto.timingSafeEqual(sha(expected), sha(given))) {
    res.status(404).json({ message: 'Not found' });
    return;
  }
  try {
    const [locations, skills, jobs, users, jobApplications] = await Promise.all([
      query(`SELECT * FROM locations`),
      query(`SELECT * FROM skills`),
      // The employer's contact person and the internal comments never leave prod.
      query(`SELECT * FROM jobs`).then((rows) => rows.map((j) => ({
        ...j, contact_person_name: '', contact_person_phone: '', contact_person_email: '', comments: '',
      }))),
      query(`SELECT id, 'משתמש' AS first_name, 'בדיקה ' || right(id, 6) AS last_name,
                    'user-' || id || '@sandbox.test' AS email, 'sbx-' || id AS phone_number,
                    NULL::timestamptz AS date_of_birth, gender, city_symbol, '' AS password, skills,
                    '' AS cv_file_url, has_applied_to_job, role, created_at, updated_at
             FROM users`),
      // Like users above: CV keys never leave prod.
      query(`SELECT id, user_id, job_id, '' AS cv_file_url, cv_scope, created_at, updated_at FROM job_applications`),
    ]);
    // Pseudonymized, but still per-person rows (gender, city, skills, applications): recorded before it leaves.
    await writeAuditStrict('system:sandbox-export', 'data.exported', req.ip ?? null, {
      users: users.length, job_applications: jobApplications.length, jobs: jobs.length,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ exportedAt: new Date().toISOString(), locations, skills, jobs, users, job_applications: jobApplications });
  } catch (e) {
    if (e instanceof AuditWriteError) { res.status(503).json({ message: 'activity log unavailable' }); return; }
    console.error('[export] failed:', safeErrorText(e));
    res.status(500).json({ message: 'Internal server error' });
  }
};
