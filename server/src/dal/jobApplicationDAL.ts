import { JobApplication } from "../models/schemas/user.js";
import { Job } from "../models/schemas/jobs.js";
import { filterOptions } from "../models/interfaces/general.interface.js";
import IJobApplication from "../models/schemas/jobApplication.js";
import { escapeLike, escapeRegex, query, queryOne } from "../config/db.js";
import { isObjectId, newObjectId } from "../utils/ids.js";
import { rowToJob } from "./jobDAL.js";

const SORT_COLUMNS: Record<string, string> = {
  publishDate: 'j.publish_date',
  updatedAt: 'j.updated_at',
  createdAt: 'j.created_at',
  title: 'j.title',
  companyName: 'j.company_name',
  status: 'j.status',
  jobAppcreatedAt: 'a.created_at',
  jobApplicationCreatedAt: 'a.created_at',
  location: 'l.city',
};

const toApplication = (r: any): IJobApplication => ({
  _id: r.id, userId: r.user_id, jobId: r.job_id, cvFileUrl: r.cv_file_url ?? '', cvScope: r.cv_scope ?? '',
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export const addJobApplication = async (
  userId: string,
  jobId: string,
  cv: { cvFileUrl?: string; cvScope?: string } = {}
): Promise<IJobApplication> => {
  const rows = await query(
    `INSERT INTO job_applications (id, user_id, job_id, cv_file_url, cv_scope) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newObjectId(), userId, jobId, cv.cvFileUrl ?? '', cv.cvScope ?? '']
  );
  return toApplication(rows[0]);
};

export const findIfJobsApplicationAlreadyApplied = async (userId: string, jobId: string): Promise<{ _id: string } | null> => {
  if (!isObjectId(userId) || !isObjectId(jobId)) return null;
  return queryOne(`SELECT id AS "_id" FROM job_applications WHERE user_id = $1 AND job_id = $2`, [userId, jobId]);
};

export const findJobsApplictionByUserId = async (userId: string): Promise<JobApplication[]> => {
  if (!isObjectId(userId)) return [];
  return query(`SELECT job_id AS "jobId" FROM job_applications WHERE user_id = $1`, [userId]);
};

export const findAllJobApplictionsDetailsByUserId = async (
  userId: string,
  filterParams?: filterOptions
): Promise<{ jobs: Job[]; total: number }> => {
  if (!isObjectId(userId)) return { jobs: [], total: 0 };
  const page = Math.max(1, Number(filterParams?.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(filterParams?.limit) || 4));
  const params: any[] = [userId];
  const where = [`a.user_id = $1`];

  const statuses = filterParams?.jobStatus ? (Array.isArray(filterParams.jobStatus) ? filterParams.jobStatus : [filterParams.jobStatus]) : [];
  if (statuses.length) {
    params.push(statuses.map(String));
    where.push(`j.status = ANY($${params.length}::text[])`);
  }
  const input = filterParams?.inputValue?.trim();
  if (input) {
    const letters = input.toLowerCase().replace(/[\s\-?!/@+*)(.:",']/g, '').split('');
    params.push(`%${escapeLike(input)}%`);
    const like = `$${params.length}`;
    const ors = [`j.description ILIKE ${like}`, `j.company_name ILIKE ${like}`];
    if (letters.length) {
      params.push(letters.map(escapeRegex).join('.*'));
      ors.unshift(`j.title ~* $${params.length}`);
    }
    where.push(`(${ors.join(' OR ')})`);
  }

  const col = filterParams?.sortField ? SORT_COLUMNS[filterParams.sortField] : undefined;
  const order = col && filterParams?.sortOrder
    ? `${col} ${String(filterParams.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'}, a.id DESC`
    : 'j.publish_date DESC, a.id DESC';

  const from = `FROM job_applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN locations l ON l.city_symbol = j.city_symbol
                WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    query(
      `SELECT j.*, l.city AS l_city, l.district AS l_district, l.city_symbol AS l_city_symbol,
              COALESCE((SELECT jsonb_object_agg(s.id, s.name) FROM skills s WHERE s.id = ANY(j.required_skills)), '{}'::jsonb) AS skills_map,
              a.created_at AS application_created_at, a.user_id AS application_user_id,
              a.cv_file_url AS application_cv_file_url, a.cv_scope AS application_cv_scope
       ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    ),
    queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count ${from}`, params),
  ]);

  const jobs = rows.map((r) => {
    const job: any = rowToJob(r);
    job.userId = r.application_user_id;
    job.jobApplicationCreatedAt = r.application_created_at;
    job.jobAppcreatedAt = new Date(r.application_created_at).toISOString();
    // The CV sent with this application: its file name and scope only (never the storage key).
    job.applicationCv = r.application_cv_file_url
      ? { fileName: String(r.application_cv_file_url).split('/').pop(), scope: r.application_cv_scope || '' }
      : null;
    return job as Job;
  });
  return { jobs, total: Number(count?.count ?? 0) };
};
