/* ============================================================================
 *  Guest (quick) applications — a visitor applies without an account.
 *
 *  Owner's rule: nothing a candidate sent is ever deleted. Every guest application is stored here first
 *  (guest_applications, with the CV key; the consent answers are in guest_consents under the same guest id),
 *  then sent to Salesforce when it is on. `salesforce_sent_at` marks what reached Salesforce, so applications
 *  stored while Salesforce was off (or failed) can be pushed later (staff backfill, pushUnsentGuestApplications).
 *  The table refuses DELETE and TRUNCATE (trigger in config/db.ts).
 *
 *  Staff see them only through peopleHandover / cvHandover (controllers/guestApplicationController.ts).
 * ========================================================================== */
import { query, queryOne } from '../config/db.js';
import appConfig from '../config/appConfig.js';
import { Guest } from '../models/interfaces/general.interface.js';
import { newObjectId } from '../utils/ids.js';

export type GuestApplicationRow = {
  id: string; application_id: string; job_id: string; full_name: string; email: string; phone_number: string;
  cv_key: string; created_at: Date; salesforce_sent_at: Date | null; salesforce_error: string | null;
};

/** Stores a guest application (before anything is sent anywhere). `guest._id` is the guest id. */
export const storeGuestApplication = async (
  guest: Guest, jobId: string, threshold: { confirmed: boolean; at: Date | null } = { confirmed: false, at: null },
): Promise<GuestApplicationRow> => {
  // threshold: confirmed the job's threshold condition (תנאי סף) and when (thresholdCondition.ts).
  const row = await queryOne<GuestApplicationRow>(
    `INSERT INTO guest_applications (id, application_id, job_id, full_name, email, phone_number, cv_key, threshold_confirmed, threshold_confirmed_at)
     VALUES ($1, $2, $3, $4, lower($5), $6, $7, $8, $9) RETURNING *`,
    [guest._id, newObjectId(), jobId, guest.fullName, guest.email, guest.phoneNumber, guest.cvFilePath ?? '', threshold.confirmed, threshold.at]);
  return row!;
};

/** A quick application of this address (lower-cased, as stored) to this job exists already. */
export const guestAlreadyApplied = async (jobId: string, email: string): Promise<boolean> =>
  !!(await queryOne(`SELECT 1 FROM guest_applications WHERE job_id = $1 AND email = lower($2) LIMIT 1`, [jobId, email]));

export const salesforceOn = () => !!appConfig.salesforce.enableSalesforce;

/** Oldest unsent first. */
export const unsentGuestApplications = (limit: number) =>
  query<GuestApplicationRow>(
    `SELECT * FROM guest_applications WHERE salesforce_sent_at IS NULL ORDER BY created_at LIMIT $1`, [limit]);

export const countUnsent = async () =>
  (await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM guest_applications WHERE salesforce_sent_at IS NULL`))?.n ?? 0;

/** The staff list: newest first; the job's title and number come along. */
export const listGuestApplications = async (opts: { page: number; limit: number; jobId?: string; unsentOnly?: boolean }) => {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.jobId) { params.push(opts.jobId); where.push(`g.job_id = $${params.length}`); }
  if (opts.unsentOnly) where.push(`g.salesforce_sent_at IS NULL`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, total] = await Promise.all([
    query<GuestApplicationRow & { job_title: string | null; job_number: number | null }>(
      `SELECT g.*, j.title AS job_title, j.job_id AS job_number FROM guest_applications g LEFT JOIN jobs j ON j.id = g.job_id
        ${w} ORDER BY g.created_at DESC, g.id DESC LIMIT ${opts.limit} OFFSET ${(opts.page - 1) * opts.limit}`, params),
    queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM guest_applications g ${w}`, params),
  ]);
  return {
    total: total?.n ?? 0,
    rows: rows.map((r) => ({
      id: r.id, jobId: r.job_id, jobTitle: r.job_title ?? '', jobNumber: r.job_number, fullName: r.full_name, email: r.email,
      phoneNumber: r.phone_number, hasCv: !!r.cv_key, createdAt: r.created_at,
      salesforceSentAt: r.salesforce_sent_at, salesforceError: r.salesforce_error,
    })),
  };
};

export const guestApplicationCvKey = async (id: string): Promise<string> =>
  (await queryOne<{ cv_key: string }>(`SELECT cv_key FROM guest_applications WHERE id = $1`, [id]))?.cv_key ?? '';
