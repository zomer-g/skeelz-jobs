/* ============================================================================
 *  Internal API — reads of candidates and applications (explicit columns: never
 *  passwords, never storage keys). Callers hand them over via peopleHandover.
 * ========================================================================== */
import { escapeLike, query, queryOne } from '../config/db.js';
import { isObjectId } from '../utils/ids.js';

export const PAGE_MAX = 50;

export const paging = (q: any) => {
  const page = Math.max(1, Math.floor(Number(q?.page)) || 1);
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(q?.limit)) || 20));
  return { page, limit, offset: (page - 1) * limit };
};

/** An ISO date/time, or undefined; anything else is an error (null). */
export const parseSince = (v: unknown): Date | undefined | null => {
  if (v === undefined || v === '') return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const CV_BASE = '/api/internal/v1';

export type CandidateOut = {
  id: string; firstName: string; lastName: string; email: string; phoneNumber: string;
  dateOfBirth: string | null; gender: string; citySymbol: number; city: string | null;
  skills: string[]; hasCv: boolean; hasAppliedToJob: boolean; createdAt: string; updatedAt: string; cvLink: string | null;
};

const toCandidate = (r: any): CandidateOut => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phoneNumber: r.phone_number,
  dateOfBirth: r.date_of_birth, gender: r.gender, citySymbol: r.city_symbol, city: r.l_city ?? null,
  skills: r.skill_names ?? [], hasCv: !!r.cv_file_url, hasAppliedToJob: !!r.has_applied_to_job,
  createdAt: r.created_at, updatedAt: r.updated_at,
  cvLink: r.cv_file_url ? `${CV_BASE}/candidates/${r.id}/cv` : null,
});

const CANDIDATE_SELECT = `
  u.id, u.first_name, u.last_name, u.email, u.phone_number, u.date_of_birth, u.gender, u.city_symbol,
  u.cv_file_url, u.has_applied_to_job, u.created_at, u.updated_at, l.city AS l_city,
  COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM skills s WHERE s.id = ANY(u.skills)), '{}') AS skill_names`;

/** Candidates (role user only), newest change first. */
export const listCandidates = async (f: { search?: string; hasCv?: boolean; updatedSince?: Date; page: number; limit: number; offset: number }) => {
  const params: any[] = [];
  const where = [`u.role = 'user'`];
  const search = f.search?.trim();
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    const p = `$${params.length}`;
    where.push(`(u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone_number ILIKE ${p}
                 OR (u.first_name || ' ' || u.last_name) ILIKE ${p})`);
  }
  if (f.hasCv === true) where.push(`u.cv_file_url <> ''`);
  if (f.hasCv === false) where.push(`u.cv_file_url = ''`);
  if (f.updatedSince) { params.push(f.updatedSince); where.push(`u.updated_at >= $${params.length}`); }
  const w = `WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    query(`SELECT ${CANDIDATE_SELECT} FROM users u LEFT JOIN locations l ON l.city_symbol = u.city_symbol ${w}
           ORDER BY u.updated_at DESC, u.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
    queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users u ${w}`, params),
  ]);
  return { rows: rows.map(toCandidate), total: count?.n ?? 0 };
};

export const getCandidate = async (id: string): Promise<CandidateOut | null> => {
  if (!isObjectId(id)) return null;
  const r = await queryOne(`SELECT ${CANDIDATE_SELECT} FROM users u LEFT JOIN locations l ON l.city_symbol = u.city_symbol
                             WHERE u.id = $1 AND u.role = 'user'`, [id]);
  return r ? toCandidate(r) : null;
};

/** The storage key of a candidate's profile CV ('' = none). Server-side only. */
export const candidateCvKey = async (id: string): Promise<string> => {
  if (!isObjectId(id)) return '';
  const r = await queryOne<{ k: string }>(`SELECT cv_file_url AS k FROM users WHERE id = $1 AND role = 'user'`, [id]);
  return r?.k ?? '';
};

export type ApplicationOut = {
  id: string; jobId: string; jobNumber: number | null; jobTitle: string | null; candidateId: string;
  createdAt: string; cvScope: string; hasCv: boolean; cvLink: string | null;
};

const toApplication = (r: any): ApplicationOut => ({
  id: r.id, jobId: r.job_id, jobNumber: r.j_number ?? null, jobTitle: r.j_title ?? null, candidateId: r.user_id,
  createdAt: r.created_at, cvScope: r.cv_scope || '', hasCv: !!r.cv_file_url,
  cvLink: r.cv_file_url ? `${CV_BASE}/applications/${r.id}/cv` : null,
});

const APP_SELECT = `a.id, a.job_id, a.user_id, a.created_at, a.cv_scope, a.cv_file_url, j.job_id AS j_number, j.title AS j_title`;

export const listApplications = async (f: { jobId?: string; candidateId?: string; since?: Date; page: number; limit: number; offset: number }) => {
  const params: any[] = [];
  const where: string[] = [];
  if (f.jobId) { params.push(f.jobId); where.push(`a.job_id = $${params.length}`); }
  if (f.candidateId) { params.push(f.candidateId); where.push(`a.user_id = $${params.length}`); }
  if (f.since) { params.push(f.since); where.push(`a.created_at >= $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    query(`SELECT ${APP_SELECT} FROM job_applications a LEFT JOIN jobs j ON j.id = a.job_id ${w}
           ORDER BY a.created_at DESC, a.id DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
    queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_applications a ${w}`, params),
  ]);
  return { rows: rows.map(toApplication), total: count?.n ?? 0 };
};

export const getApplication = async (id: string): Promise<(ApplicationOut & { cvKey: string }) | null> => {
  if (!isObjectId(id)) return null;
  const r = await queryOne(`SELECT ${APP_SELECT} FROM job_applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.id = $1`, [id]);
  return r ? { ...toApplication(r), cvKey: r.cv_file_url || '' } : null;
};
