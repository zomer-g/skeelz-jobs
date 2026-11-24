// Employer accounts (docs/employers.md): the employer's own details, their submissions and published jobs, and
// their edit requests. Every "own" query takes the user id from the session (never from the request) and
// returns only rows linked to it. Nothing here reads candidates, applications or CVs (forwardDAL.ts does, for the
// applicants staff forwarded).
import { query, queryOne, pool } from '../config/db.js';
import { isObjectId, newObjectId } from '../utils/ids.js';
import { TERMS_VERSION } from '../security/consent.js';
import { EditableJobValues, EmployerProfile } from '../security/employer.js';
import { rowToUser } from './userDAL.js';
import { IUser } from '../models/schemas/user.js';

// ---- the account -------------------------------------------------------------------------
export type EmployerRecord = { id: string; email: string; firstName: string; lastName: string; companyName: string; phone: string; jobTitle: string | null; createdAt: Date };

const toEmployer = (r: any): EmployerRecord => ({
  id: r.id, email: r.email, firstName: r.first_name, lastName: r.last_name,
  companyName: r.company_name ?? '', phone: r.phone ?? '', jobTitle: r.job_title ?? null, createdAt: r.created_at,
});

/**
 * Creates an employer account and its details in one transaction. role is always 'employer' here; the email comes
 * from the caller's verified sign-up cookie. No password. `sso`: the identity the account is linked to.
 * Throws 'email_taken' when the address already has an account (the caller answers 409).
 */
export const createEmployer = async (
  email: string, p: EmployerProfile,
  opts: { sso?: { sub: string; provider: 'xhostd' | 'microsoft' }; consent: { marketing: boolean } },
): Promise<IUser> => {
  const id = newObjectId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [email]);
    if (exists.rowCount) { await client.query('ROLLBACK'); throw Object.assign(new Error('email_taken'), { code: 'email_taken' }); }
    const r = await client.query(
      `INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, role,
                          has_applied_to_job, xhostd_sub, ms_sub, terms_version, terms_accepted_at, marketing_consent, marketing_consent_at)
       VALUES ($1, $2, $3, lower($4), NULL, '', 0, '', 'employer', false, $5, $6, $7, now(), $8, now()) RETURNING *`,
      [id, p.firstName, p.lastName, email, opts.sso?.provider === 'xhostd' ? opts.sso.sub : null,
        opts.sso?.provider === 'microsoft' ? opts.sso.sub : null, TERMS_VERSION, opts.consent.marketing]);
    await client.query(`INSERT INTO employer_profiles (user_id, company_name, phone, job_title) VALUES ($1, $2, $3, $4)`,
      [id, p.companyName, p.phone, p.jobTitle ?? null]);
    await client.query(`INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
                        VALUES ('user', $1, $2, $3, 'employer_signup')`, [id, TERMS_VERSION, opts.consent.marketing]);
    await client.query('COMMIT');
    return rowToUser(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Several roles per account (owner, 23.11.2026): adds the employer role to an EXISTING account (a candidate or staff
 * member who now also posts jobs) with its employer details, and stores the consent given on that form (users + a
 * consent_records row in the same statement). The email and sign-in stay the account's. Returns false when the
 * account already holds the role or is gone / deactivated.
 */
export const addEmployerRole = async (userId: string, p: EmployerProfile, consent: { marketing: boolean }): Promise<boolean> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE users SET roles = array_append(roles, 'employer'), updated_at = now()
        WHERE id = $1 AND deactivated_at IS NULL AND NOT ('employer' = ANY(roles)) RETURNING id`, [userId]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query(
      `INSERT INTO employer_profiles (user_id, company_name, phone, job_title) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET company_name = EXCLUDED.company_name, phone = EXCLUDED.phone,
         job_title = EXCLUDED.job_title, updated_at = now()`, [userId, p.companyName, p.phone, p.jobTitle ?? null]);
    await client.query(
      `WITH u AS (UPDATE users SET terms_version = $2, terms_accepted_at = now(), marketing_consent = $3, marketing_consent_at = now()
                    WHERE id = $1 RETURNING id)
       INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
       SELECT 'user', u.id, $2, $3, 'employer_role_added' FROM u`, [userId, TERMS_VERSION, consent.marketing]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/** The employer's own record (null when the account does not hold the employer role). */
export const getEmployer = async (userId: string): Promise<EmployerRecord | null> => {
  if (!isObjectId(userId)) return null;
  const r = await queryOne(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, p.company_name, p.phone, p.job_title
       FROM users u LEFT JOIN employer_profiles p ON p.user_id = u.id WHERE u.id = $1 AND 'employer' = ANY(u.roles)`, [userId]);
  return r ? toEmployer(r) : null;
};

/** Updates the employer's own details (allowlisted fields only; never email or role). */
export const updateEmployer = async (userId: string, v: Partial<EmployerProfile>): Promise<EmployerRecord | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const own = await client.query<{ candidate: boolean }>(
      `SELECT 'user' = ANY(roles) AS candidate FROM users WHERE id = $1 AND 'employer' = ANY(roles) FOR UPDATE`, [userId]);
    if (!own.rowCount) { await client.query('ROLLBACK'); return null; }
    // Someone who is also a candidate keeps their name in the personal area (the candidate's record, maybe read-only
    // as a candidate of the existing site): the employer form does not change it.
    if (own.rows[0].candidate) { delete (v as any).firstName; delete (v as any).lastName; }
    if (v.firstName !== undefined || v.lastName !== undefined) {
      await client.query(`UPDATE users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), updated_at = now() WHERE id = $1`,
        [userId, v.firstName ?? null, v.lastName ?? null]);
    }
    const sets: string[] = []; const vals: unknown[] = [userId];
    for (const [k, col] of [['companyName', 'company_name'], ['phone', 'phone'], ['jobTitle', 'job_title']] as const) {
      if ((v as any)[k] === undefined) continue;
      vals.push((v as any)[k]); sets.push(`${col} = $${vals.length}`);
    }
    if (sets.length) await client.query(`UPDATE employer_profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, vals);
    if (sets.length && !(v.firstName || v.lastName)) await client.query(`UPDATE users SET updated_at = now() WHERE id = $1`, [userId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return getEmployer(userId);
};

// ---- own submissions and jobs --------------------------------------------------------------
export type OwnSubmission = {
  id: string; status: string; title: string; companyName: string; city: string | null; createdAt: Date;
  reviewedAt: Date | null; rejectReason: string | null; jobId: string | null; claimed: boolean;
};

/** The employer's submissions (sent while signed in, or claimed). No contact details: they are the employer's own. */
export const ownSubmissions = async (userId: string): Promise<OwnSubmission[]> => {
  const rows = await query(
    `SELECT s.id, s.status, s.title, s.company_name, s.created_at, s.reviewed_at, s.reject_reason, s.job_id, s.claimed_at, l.city
       FROM job_submissions s LEFT JOIN locations l ON l.city_symbol = s.city_symbol
      WHERE s.submitted_by_user_id = $1 ORDER BY s.created_at DESC LIMIT 200`, [userId]);
  return rows.map((r: any) => ({
    id: r.id, status: r.status, title: r.title, companyName: r.company_name, city: r.city ?? null, createdAt: r.created_at,
    reviewedAt: r.reviewed_at, rejectReason: r.reject_reason, jobId: r.job_id, claimed: !!r.claimed_at,
  }));
};

export type OwnJob = {
  id: string; jobId: number; title: string; companyName: string; status: string; publishDate: Date; archived: boolean;
  readOnly: boolean; pendingRequestId: string | null; updatedAt: Date;
};

/** The employer's published jobs (employer_jobs: linked when their submission was approved). */
export const ownJobs = async (userId: string): Promise<OwnJob[]> => {
  const rows = await query(
    `SELECT j.id, j.job_id, j.title, j.company_name, j.status, j.publish_date, j.deleted_at, j.imported_from_live, j.updated_at,
            (SELECT r.id FROM job_edit_requests r WHERE r.job_id = j.id AND r.status = 'pending' LIMIT 1) AS pending_id
       FROM jobs j JOIN employer_jobs e ON e.job_id = j.id
      WHERE e.user_id = $1 ORDER BY j.publish_date DESC LIMIT 200`, [userId]);
  return rows.map((r: any) => ({
    id: r.id, jobId: r.job_id, title: r.title, companyName: r.company_name, status: r.status, publishDate: r.publish_date,
    archived: !!r.deleted_at, readOnly: !!r.imported_from_live, pendingRequestId: r.pending_id ?? null, updatedAt: r.updated_at,
  }));
};

/** Is this job the employer's? */
export const ownsJob = async (userId: string, jobId: string): Promise<boolean> => {
  if (!isObjectId(jobId)) return false;
  return !!(await queryOne(`SELECT 1 FROM employer_jobs WHERE job_id = $1 AND user_id = $2`, [jobId, userId]));
};

/** Links a published job to its employer (approval of their submission, or a claim after approval). Never moves a
 *  job that is already someone's. */
export const linkJob = (jobId: string, userId: string, via: 'submission' | 'claim') =>
  query(`INSERT INTO employer_jobs (job_id, user_id, via) VALUES ($1, $2, $3) ON CONFLICT (job_id) DO NOTHING`, [jobId, userId, via]);

/** Earlier anonymous submissions whose contact email is the account's (verified) sign-in email: how many. */
export const claimableCount = async (email: string): Promise<number> => {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM job_submissions WHERE submitted_by_user_id IS NULL AND lower(contact_email) = lower($1)`, [email]);
  return Number(r?.n ?? 0);
};

/** Claims them (only unowned ones, only by that email); approved ones bring their job. Returns the claimed ids. */
export const claimSubmissions = async (userId: string, email: string): Promise<{ ids: string[]; jobs: number; jobIds: string[] }> => {
  const rows = await query<{ id: string; job_id: string | null }>(
    `UPDATE job_submissions SET submitted_by_user_id = $1, claimed_at = now(), updated_at = now()
      WHERE submitted_by_user_id IS NULL AND lower(contact_email) = lower($2) RETURNING id, job_id`, [userId, email]);
  const jobIds: string[] = [];
  for (const r of rows) if (r.job_id) { await linkJob(r.job_id, userId, 'claim'); jobIds.push(r.job_id); }
  return { ids: rows.map((r) => r.id), jobs: jobIds.length, jobIds };
};

// ---- edit requests ---------------------------------------------------------------------------
export type EditRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export const EDIT_STATUSES: EditRequestStatus[] = ['pending', 'approved', 'rejected', 'withdrawn'];
export type EditRequest = {
  id: string; jobId: string; jobNumber: number | null; jobTitle: string | null; userId: string; status: EditRequestStatus;
  changes: Partial<EditableJobValues>; base: Partial<EditableJobValues>; note: string | null; createdAt: Date;
  reviewedAt: Date | null; reviewedBy: string | null; rejectReason: string | null;
  employer?: { firstName: string; lastName: string; companyName: string } | null;
};

const toRequest = (r: any, withEmployer = false): EditRequest => ({
  id: r.id, jobId: r.job_id, jobNumber: r.job_number ?? null, jobTitle: r.job_title ?? null, userId: r.user_id, status: r.status,
  changes: r.changes ?? {}, base: r.base ?? {}, note: r.note ?? null, createdAt: r.created_at, reviewedAt: r.reviewed_at,
  reviewedBy: r.reviewed_by, rejectReason: r.reject_reason,
  ...(withEmployer ? { employer: r.e_first ? { firstName: r.e_first, lastName: r.e_last, companyName: r.e_company ?? '' } : null } : {}),
});

const REQ_SELECT = `r.*, j.job_id AS job_number, j.title AS job_title`;

/** Creates a pending request. Returns null when the job already has one pending (unique index). */
export const createEditRequest = async (
  jobId: string, userId: string, changes: Partial<EditableJobValues>, base: Partial<EditableJobValues>, note: string | null,
): Promise<string | null> => {
  const id = newObjectId();
  try {
    await query(`INSERT INTO job_edit_requests (id, job_id, user_id, changes, base, note) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [id, jobId, userId, JSON.stringify(changes), JSON.stringify(base), note]);
    return id;
  } catch (e: any) {
    if (e?.code === '23505') return null;
    throw e;
  }
};

/** The employer's own requests. `reviewedBy` holds the reviewer's staff email (actorOf): never sent to an employer —
 *  they see only 'self' (they withdrew it) or 'staff'. */
export const ownEditRequests = async (userId: string): Promise<EditRequest[]> =>
  (await query(`SELECT ${REQ_SELECT} FROM job_edit_requests r LEFT JOIN jobs j ON j.id = r.job_id
                 WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [userId]))
    .map((r) => ({ ...toRequest(r), reviewedBy: r.reviewed_by === 'self' ? 'self' : r.reviewed_by ? 'staff' : null }));

/** The employer withdraws their own pending request. */
export const withdrawEditRequest = async (id: string, userId: string): Promise<boolean> => {
  if (!isObjectId(id)) return false;
  return (await query(`UPDATE job_edit_requests SET status = 'withdrawn', reviewed_at = now(), reviewed_by = 'self'
                        WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`, [id, userId])).length > 0;
};

// staff (content managers) ----
export const listEditRequests = async (status: EditRequestStatus): Promise<{ items: EditRequest[]; counts: Record<EditRequestStatus, number> }> => {
  const rows = await query(
    `SELECT ${REQ_SELECT}, u.first_name AS e_first, u.last_name AS e_last, p.company_name AS e_company
       FROM job_edit_requests r LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN employer_profiles p ON p.user_id = r.user_id
      WHERE r.status = $1 ORDER BY r.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`, [status]);
  const c = await query<{ status: EditRequestStatus; n: number }>(`SELECT status, COUNT(*)::int AS n FROM job_edit_requests GROUP BY status`);
  const counts = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 } as Record<EditRequestStatus, number>;
  for (const r of c) counts[r.status] = Number(r.n);
  return { items: rows.map((r) => toRequest(r, true)), counts };
};

export const getEditRequest = async (id: string): Promise<EditRequest | null> => {
  if (!isObjectId(id)) return null;
  const r = await queryOne(
    `SELECT ${REQ_SELECT}, u.first_name AS e_first, u.last_name AS e_last, p.company_name AS e_company
       FROM job_edit_requests r LEFT JOIN jobs j ON j.id = r.job_id LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN employer_profiles p ON p.user_id = r.user_id WHERE r.id = $1`, [id]);
  return r ? toRequest(r, true) : null;
};

/** Claims a pending request for review (one reviewer wins). */
export const claimEditRequest = async (id: string, by: string, status: 'approved' | 'rejected', reason: string | null = null): Promise<boolean> => {
  if (!isObjectId(id)) return false;
  return (await query(`UPDATE job_edit_requests SET status = $3, reviewed_at = now(), reviewed_by = $2, reject_reason = $4
                        WHERE id = $1 AND status = 'pending' RETURNING id`, [id, by, status, reason])).length > 0;
};

/** Approval failed after the claim (the job update threw): back to pending. */
export const releaseEditRequest = (id: string) =>
  query(`UPDATE job_edit_requests SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL WHERE id = $1 AND status = 'approved'`, [id]);

/** Retention: reviewed or withdrawn requests go with the submissions' period (SUBMISSION_RETENTION_MONTHS). */
export const purgeEditRequests = async (months: number): Promise<number> =>
  (await query(`DELETE FROM job_edit_requests WHERE status <> 'pending' AND reviewed_at < now() - make_interval(months => $1) RETURNING id`, [months])).length;
