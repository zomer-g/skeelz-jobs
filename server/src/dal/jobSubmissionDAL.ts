// Employer job submissions (table job_submissions, see config/db.ts).
// Nothing here is ever read by the public job queries (jobDAL): a submission
// becomes a job only through approve() in the controller.
import { query, queryOne } from '../config/db.js';
import { newObjectId, isObjectId } from '../utils/ids.js';
import { SubmissionInput } from '../services/jobSubmissionRules.js';
import { SUBMISSION_RETENTION_MONTHS } from '../security/pure.js';

export type SubmissionStatus = 'pending' | 'approved' | 'rejected';
export const STATUSES: SubmissionStatus[] = ['pending', 'approved', 'rejected'];

export interface SubmissionSummary {
  id: string;
  status: SubmissionStatus;
  title: string;
  companyName: string;
  citySymbol: number;
  city: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  jobId: string | null;
}

export interface Submission extends SubmissionSummary {
  jobScope: string[];
  requiredSkills: string[];
  requiredSkillsDetails: Record<string, string>;
  description: string; // plain text
  externalLink: string | null;
  publicEmail: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  consentAt: Date;
  rejectReason: string | null;
}

const COLUMNS: Record<keyof SubmissionInput, string> = {
  title: 'title',
  companyName: 'company_name',
  citySymbol: 'city_symbol',
  jobScope: 'job_scope',
  requiredSkills: 'required_skills',
  description: 'description',
  externalLink: 'external_link',
  publicEmail: 'public_email',
  contactName: 'contact_name',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
};

const toSummary = (r: any): SubmissionSummary => ({
  id: r.id,
  status: r.status,
  title: r.title,
  companyName: r.company_name,
  citySymbol: r.city_symbol,
  city: r.l_city ?? null,
  createdAt: r.created_at,
  reviewedAt: r.reviewed_at,
  reviewedBy: r.reviewed_by,
  jobId: r.job_id,
});

const toFull = (r: any): Submission => ({
  ...toSummary(r),
  jobScope: r.job_scope ?? [],
  requiredSkills: r.required_skills ?? [],
  requiredSkillsDetails: r.skills_map ?? {},
  description: r.description,
  externalLink: r.external_link,
  publicEmail: r.public_email,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  consentAt: r.consent_at,
  rejectReason: r.reject_reason,
});

const SELECT = `
  s.*, l.city AS l_city,
  COALESCE((SELECT jsonb_object_agg(k.id, k.name) FROM skills k WHERE k.id = ANY(s.required_skills)), '{}'::jsonb) AS skills_map
  FROM job_submissions s LEFT JOIN locations l ON l.city_symbol = s.city_symbol`;

export const countPending = async (): Promise<number> => {
  const r = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_submissions WHERE status = 'pending'`);
  return Number(r?.n ?? 0);
};

export const create = async (v: SubmissionInput): Promise<string> => {
  const id = newObjectId();
  const cols = ['id', 'consent_at', ...Object.values(COLUMNS)];
  const vals = [id, new Date(), ...Object.keys(COLUMNS).map((k) => (v as any)[k] ?? null)];
  await query(`INSERT INTO job_submissions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  return id;
};

/** The list shows no contact details (they are shown, and logged, only when one submission is opened). */
export const list = async (status: SubmissionStatus, limit = 100): Promise<{ items: SubmissionSummary[]; counts: Record<SubmissionStatus, number> }> => {
  const rows = await query(
    `SELECT s.id, s.status, s.title, s.company_name, s.city_symbol, s.created_at, s.reviewed_at, s.reviewed_by, s.job_id, l.city AS l_city
     FROM job_submissions s LEFT JOIN locations l ON l.city_symbol = s.city_symbol
     WHERE s.status = $1 ORDER BY s.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT $2`,
    [status, Math.max(1, Math.min(200, limit))]
  );
  const c = await query<{ status: SubmissionStatus; n: number }>(`SELECT status, COUNT(*)::int AS n FROM job_submissions GROUP BY status`);
  const counts = { pending: 0, approved: 0, rejected: 0 } as Record<SubmissionStatus, number>;
  for (const r of c) counts[r.status] = Number(r.n);
  return { items: rows.map(toSummary), counts };
};

export const get = async (id: string): Promise<Submission | null> => {
  if (!isObjectId(id)) return null;
  const r = await queryOne(`SELECT ${SELECT} WHERE s.id = $1`, [id]);
  return r ? toFull(r) : null;
};

/** Staff edit — only while pending. Returns false when not found or no longer pending. */
export const updatePending = async (id: string, v: Partial<SubmissionInput>): Promise<boolean> => {
  if (!isObjectId(id)) return false;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, col] of Object.entries(COLUMNS)) {
    if (!(k in v)) continue;
    vals.push((v as any)[k] ?? null);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return !!(await queryOne(`SELECT 1 FROM job_submissions WHERE id = $1 AND status = 'pending'`, [id]));
  vals.push(id);
  const r = await query(`UPDATE job_submissions SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} AND status = 'pending' RETURNING id`, vals);
  return r.length > 0;
};

/** Claims a pending submission for approval (only one reviewer can win). Returns the row, or null. */
export const claimForApproval = async (id: string, by: string): Promise<Submission | null> => {
  if (!isObjectId(id)) return null;
  const r = await query(
    `UPDATE job_submissions SET status = 'approved', reviewed_at = now(), reviewed_by = $2, updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`, [id, by]);
  return r.length ? get(id) : null;
};

export const setJob = async (id: string, jobId: string) =>
  query(`UPDATE job_submissions SET job_id = $2, updated_at = now() WHERE id = $1`, [id, jobId]);

/** Approval failed after the claim (job could not be created): back to pending. */
export const releaseClaim = async (id: string) =>
  query(`UPDATE job_submissions SET status = 'pending', reviewed_at = NULL, reviewed_by = NULL, updated_at = now() WHERE id = $1 AND job_id IS NULL`, [id]);

export const reject = async (id: string, by: string, reason: string | null): Promise<boolean> => {
  if (!isObjectId(id)) return false;
  const r = await query(
    `UPDATE job_submissions SET status = 'rejected', reviewed_at = now(), reviewed_by = $2, reject_reason = $3, updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING id`, [id, by, reason]);
  return r.length > 0;
};

/** Retention: submissions (and the employer's contact details) SUBMISSION_RETENTION_MONTHS after review, or after sending if never reviewed. */
export const purge = async (): Promise<number> => {
  const r = await query(
    `DELETE FROM job_submissions WHERE COALESCE(reviewed_at, created_at) < now() - make_interval(months => $1) RETURNING id`,
    [SUBMISSION_RETENTION_MONTHS]);
  return r.length;
};
