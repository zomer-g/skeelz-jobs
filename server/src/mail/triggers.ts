/* ============================================================================
 *  The events: where in the site each service email is triggered, and with which values (docs/mail.md).
 *  Every function here never throws and never delays the action that triggered it beyond the send itself.
 *  Values are only what the email's kind lists in catalog.ts.
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { query, queryOne } from '../config/db.js';
import { EMAIL_CODE } from '../security/emailCode.js';
import { safeErrorText } from '../security/pure.js';
import { formatToIsraelTime } from '../utils/utils.js';
import { isEnabled, sendMail, SendResult } from './mailService.js';
import { mailKind } from './catalog.js';

const base = () => (appConfig.clientBaseUrl || '').replace(/\/+$/, '');
export const siteUrl = () => base();
export const jobLink = (jobId: string) => (base() ? `${base()}/job/${jobId}` : '');
const firstWord = (name: string) => String(name || '').trim().split(/\s+/)[0] || '';
const safe = async (label: string, fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { console.error(`[mail] ${label} failed`, safeErrorText(e)); }
};

interface JobLike { _id?: unknown; id?: unknown; jobId?: unknown; title?: string; companyName?: string; location?: { city?: string } | null;
  publishDate?: unknown; contactPersonName?: string; contactPersonEmail?: string; contactPersonPhone?: string; isSelfApply?: boolean }
const idOf = (j: JobLike) => String(j._id ?? j.id ?? '');

// ---- candidates ----------------------------------------------------------------------------------------------------
export const mailSignInCode = (to: string, code: string): Promise<SendResult> =>
  sendMail('sign_in_code', to, { code, minutes: String(EMAIL_CODE.ttlMinutes), siteUrl: siteUrl() });

export const mailWelcome = (user: { email: string; firstName?: string }) =>
  safe('welcome', () => sendMail('welcome', user.email, { firstName: user.firstName ?? '', siteUrl: siteUrl(), profileLink: siteUrl() }));

/** The candidate's own confirmation (registered or guest). */
export const mailApplicationReceived = (to: string, name: string, job: JobLike) =>
  safe('application_received', () => sendMail('application_received', to, {
    firstName: firstWord(name), jobTitle: job.title ?? '', companyName: job.companyName ?? '', jobLink: jobLink(idOf(job)), siteUrl: siteUrl(),
  }));

/** After "העברה למעסיק": the candidate is told, and the employer gets an invitation to their area (no candidate data). */
export const mailForwarded = (f: { kind: string; applicationId: string; candidateId: string; jobId: string; employerId: string }) =>
  safe('forwarded', async () => {
    const job = await queryOne<{ title: string; company_name: string }>(`SELECT title, company_name FROM jobs WHERE id = $1`, [f.jobId]);
    if (!job) return;
    const candidate = f.kind === 'guest'
      ? await queryOne<{ email: string; name: string }>(`SELECT email, full_name AS name FROM guest_applications WHERE id = $1`, [f.candidateId])
      : await queryOne<{ email: string; name: string }>(`SELECT email, first_name AS name FROM users WHERE id = $1 AND deactivated_at IS NULL`, [f.candidateId]);
    if (candidate) {
      await sendMail('application_forwarded', candidate.email, {
        firstName: firstWord(candidate.name), jobTitle: job.title, companyName: job.company_name, siteUrl: siteUrl(),
      });
    }
    const employer = await queryOne<{ email: string; first_name: string }>(
      `SELECT email, first_name FROM users WHERE id = $1 AND 'employer' = ANY(roles) AND deactivated_at IS NULL`, [f.employerId]);
    if (employer) {
      await sendMail('employer_new_applicant', employer.email, {
        firstName: employer.first_name, jobTitle: job.title, areaLink: base() ? `${base()}/employer` : '', siteUrl: siteUrl(),
      });
    }
  });

// ---- employers -----------------------------------------------------------------------------------------------------
export const mailSubmissionDecision = (s: { contactEmail: string; contactName: string; title: string }, decision: { approved: true; jobId: string } | { approved: false; reason: string | null }) =>
  safe('submission decision', () => decision.approved
    ? sendMail('submission_approved', s.contactEmail, { contactName: s.contactName, jobTitle: s.title, jobLink: jobLink(decision.jobId), siteUrl: siteUrl() })
    : sendMail('submission_rejected', s.contactEmail, { contactName: s.contactName, jobTitle: s.title, reason: decision.reason ?? '', siteUrl: siteUrl() }));

export const mailEditRequestDecision = (r: { userId: string; jobId: string; jobTitle: string | null }, decision: { approved: boolean; reason?: string | null }) =>
  safe('edit request decision', async () => {
    const employer = await queryOne<{ email: string; first_name: string }>(
      `SELECT email, first_name FROM users WHERE id = $1 AND 'employer' = ANY(roles) AND deactivated_at IS NULL`, [r.userId]);
    if (!employer) return;
    const title = r.jobTitle ?? (await queryOne<{ title: string }>(`SELECT title FROM jobs WHERE id = $1`, [r.jobId]))?.title ?? '';
    await (decision.approved
      ? sendMail('edit_request_approved', employer.email, { firstName: employer.first_name, jobTitle: title, jobLink: jobLink(r.jobId), siteUrl: siteUrl() })
      : sendMail('edit_request_rejected', employer.email, { firstName: employer.first_name, jobTitle: title, reason: decision.reason ?? '', siteUrl: siteUrl() }));
  });

// ---- staff ---------------------------------------------------------------------------------------------------------
export const roleName = (role: string) => role === 'admin' ? 'מנהל/ת מערכת' : role === 'placement_coordinator' ? 'רכז/ת השמה' : 'מנהל/ת תוכן';

export const mailStaffInvite = (to: string, role: string): Promise<SendResult> =>
  sendMail('staff_invite', to, { roleName: roleName(role), siteUrl: siteUrl() });

/** The team's notice of a new application (to APPLICATION_NOTIFICATION_EMAIL; nothing when it is not set). */
export const mailStaffNewApplication = (applicant: { name: string; email: string; phone: string; guest: boolean }, job: JobLike) =>
  safe('staff new application', () => sendMail('staff_new_application', appConfig.applicationNotificationEmail, {
    candidateName: applicant.name, candidateEmail: applicant.email, candidatePhone: applicant.phone || 'לא צוין',
    applicantType: applicant.guest ? 'בלי חשבון (הגשה מהירה)' : 'רשום/ה באתר',
    jobTitle: job.title ?? '', jobNumber: String(job.jobId ?? ''), companyName: job.companyName ?? '', city: job.location?.city ?? '',
    publishDate: job.publishDate ? formatToIsraelTime(new Date(job.publishDate as string)) : '',
    contactPersonName: job.contactPersonName || 'לא צוין', contactPersonEmail: job.contactPersonEmail || 'לא צוין',
    contactPersonPhone: job.contactPersonPhone || 'לא צוין',
    applyType: job.isSelfApply ? 'הוגש באופן עצמאי' : applicant.guest ? 'הגשה ישירה ל-SKEELZ (ליד, אורח)' : 'הגשה ישירה ל-SKEELZ',
    applicationTime: formatToIsraelTime(new Date()),
  }));

export const mailStaffJobSubmission = (id: string, v: { title: string; companyName: string }) =>
  safe('staff job submission', () => sendMail('staff_job_submission', appConfig.applicationNotificationEmail, {
    jobTitle: v.title, companyName: v.companyName, submissionId: id, reviewLink: base() ? `${base()}/jobs-management/submissions` : '',
  }));

// ---- "a job you applied to closed": a small worker over job_inactive_since --------------------------------------------
// Once per job, ever (mail_job_closed). Only jobs that stopped being active after the event was last turned on and within
// the last day, so turning it on never mails about old jobs. Jobs of the existing site (mirror) are skipped. Sent one by
// one at a gentle pace.
const PACE_MS = 600;
const MAX_PER_JOB = 1000;
let running = false;

export const runJobClosedMail = async (): Promise<number> => {
  const k = mailKind('job_closed')!;
  if (running || !(await isEnabled(k))) return 0;
  running = true;
  let sent = 0;
  try {
    const since = await queryOne<{ enabled_at: Date | null }>(`SELECT enabled_at FROM mail_events WHERE kind = 'job_closed'`);
    const from = since?.enabled_at ?? null;
    if (!from) return 0; // never turned on from the screen
    const jobs = await query<{ id: string; title: string; company_name: string }>(
      `SELECT j.id, j.title, j.company_name FROM job_inactive_since s JOIN jobs j ON j.id = s.job_id
        WHERE s.since IS NOT NULL AND s.since >= $1 AND s.since > now() - interval '1 day'
          AND j.legacy_state IS DISTINCT FROM 'mirror' AND NOT j.imported_from_live
          AND NOT EXISTS (SELECT 1 FROM mail_job_closed m WHERE m.job_id = j.id)
        ORDER BY s.since LIMIT 20`, [from]);
    for (const job of jobs) {
      // Claimed first: a crash in the middle never mails the same job twice.
      const claimed = await query(`INSERT INTO mail_job_closed (job_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [job.id]);
      if (!claimed.length) continue;
      const people = await query<{ email: string; name: string }>(
        `SELECT u.email, u.first_name AS name FROM job_applications a JOIN users u ON u.id = a.user_id AND u.deactivated_at IS NULL
          WHERE a.job_id = $1
         UNION
         SELECT g.email, g.full_name AS name FROM guest_applications g WHERE g.job_id = $1
         LIMIT $2`, [job.id, MAX_PER_JOB]);
      let n = 0;
      for (const [i, p] of people.entries()) {
        const r = await sendMail('job_closed', p.email, { firstName: firstWord(p.name), jobTitle: job.title, companyName: job.company_name, siteUrl: siteUrl() },
          { idempotencyKey: `job_closed:${job.id}:${i}` });
        if (r.status === 'sent' || r.status === 'off') n++;
        await new Promise((res) => setTimeout(res, PACE_MS));
      }
      await query(`UPDATE mail_job_closed SET notified = $2, done_at = now() WHERE job_id = $1`, [job.id, n]);
      console.info(`[mail] job_closed job=${job.id} recipients=${n}`);
      sent += n;
    }
    return sent;
  } catch (e) {
    console.error('[mail] job_closed run failed', safeErrorText(e));
    return sent;
  } finally {
    running = false;
  }
};

export const startMailWorker = () => {
  const every = Number(process.env.MAIL_WORKER_MS) > 0 ? Number(process.env.MAIL_WORKER_MS) : 5 * 60_000;
  setTimeout(() => { void runJobClosedMail(); }, 20_000).unref();
  setInterval(() => { void runJobClosedMail(); }, every).unref();
};
