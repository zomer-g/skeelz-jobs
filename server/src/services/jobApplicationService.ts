import * as jobApplicationDAL from '../dal/jobApplicationDAL.js';
import { AxiosError, isAxiosError } from 'axios';
import { AuthErrorCodes, AuthErrorMessages, JobsErrorCodes, JobsErrorMessages } from '../i18n/i18n.js';
import { mailApplicationReceived, mailStaffNewApplication } from '../mail/triggers.js';
import { queueSalesforce } from './salesforceSync.js'
import { getUserById } from './userService.js';
import { fetchJobById } from './jobService.js';
import appConfig from '../config/appConfig.js';
import { Job } from '../models/schemas/jobs.js';
import { filterOptions, Guest } from '../models/interfaces/general.interface.js';
import * as userService  from '../services/userService.js';
import * as smooveService from './smooveService.js'
import { generateRandomId } from '../utils/utils.js';
import { JobStatus } from '../models/enums.js';
import { isOpenByLink } from '../models/schemas/jobBoard.js';
import { claimCvUpload, cvUploadClaimable } from './s3Service.js';
import IJobApplication from '../models/schemas/jobApplication.js';
import { checkGuestApply, checkRegularApply, DEFAULT_APPLY_POLICY } from '../models/schemas/applyPolicy.js';
import { CvMode, parseCvChoice, resolveApplicationCv } from './applicationCv.js';
import { query } from '../config/db.js';
import { TERMS_VERSION } from '../security/consent.js';
import { mayPushToList } from './marketingList.js';
import { guestAlreadyApplied, storeGuestApplication } from './guestApplications.js';
import { thresholdConditionOf, thresholdRecord, thresholdRefusal } from '../models/schemas/thresholdCondition.js';
import { ThresholdNotConfirmedError, assertCandidateEditable, assertJobTakesApplications } from '../middleware/errorMiddleware.js';




/** The consent step of a registered application (controllers/jobController.ts applyJob). `check` throws when the
 * boxes are still missing (→ 428 consent_needed); `record` stores the answers. Both run only once every other rule
 * passed: a refused application stores no consent, and a missing CV is reported before the consent question. */
export interface ApplyConsentSteps { check: () => void | Promise<void>; record: () => Promise<void> }

/**
 * A registered candidate applies. `rawCvChoice` is the request's `cv` field
 * (see services/applicationCv.ts); without it the profile CV is used.
 */
export const addJobApplication = async (userID: string, jobId: string, rawCvChoice?: unknown, thresholdConfirmed = false, consent?: ApplyConsentSteps) => {
  const cvChoice = parseCvChoice(rawCvChoice);
  const user = await getUserById(userID);

  if (!user) {
    throw new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED);
  }
  const job = await fetchJobById(jobId);

  if (!job || !job._id || !isOpenByLink(job)) { // Active, not archived, already published (jobBoard.ts)
    throw new AxiosError(JobsErrorMessages.JOB_NOT_FOUND, JobsErrorCodes.JOB_NOT_FOUND);
  }
  // Owner, 23.11.2026: applications to the existing site's jobs are not taken here; jobs created on this site take
  // them from every candidate, one copied from the existing site included. Before anything is claimed or stored.
  assertJobTakesApplications(job);
  // A candidate of the existing site keeps their details read-only until the cutover: they apply with the CV on
  // file or one for this job only, never by replacing the profile CV (refused before the upload is claimed).
  const profileLocked = user.legacyState === 'mirror';
  if (profileLocked && cvChoice.mode === CvMode.REPLACE_PROFILE) assertCandidateEditable(user);

  const alreadyApplied = await findIfJobsApplicationAlreadyApplied(user._id.toString(), job._id.toString());
  if (alreadyApplied) {
    throw new AxiosError(JobsErrorMessages.ALREADY_APPLIED, JobsErrorCodes.ALREADY_APPLIED);
  }

  // Threshold condition (תנאי סף): refused unless confirmed, before any CV is claimed or anything stored.
  if (thresholdRefusal(job.thresholdCondition, thresholdConfirmed)) {
    throw new ThresholdNotConfirmedError(thresholdConditionOf(job.thresholdCondition)!);
  }

  // CV rule for regular applications (applyPolicy.ts): checked before anything is claimed or stored.
  // With mode 'profile' the profile CV is the CV; an upload choice always carries one (resolveApplicationCv).
  const regularPolicy = job.applyPolicy ?? DEFAULT_APPLY_POLICY;
  if (cvChoice.mode === 'profile' && checkRegularApply(regularPolicy, !!user.cvFileUrl) === 'cv-required') {
    throw new AxiosError(JobsErrorMessages.CV_REQUIRED, JobsErrorCodes.CV_REQUIRED);
  }
  // Consent (security/consent.ts): asked only now, after the job, duplicate, threshold and CV rules; before any CV is claimed.
  await consent?.check();

  const cv = await resolveApplicationCv(cvChoice, { id: user._id.toString(), cvFileUrl: user.cvFileUrl }, {
    claimUpload: (cvFilePath: string, ownerId: string) => claimCvUpload(cvFilePath, ownerId, { via: 'application' }),
    setProfileCv: userService.setProfileCv,
  });
  if (checkRegularApply(regularPolicy, !!cv.cvFileUrl) === 'cv-required') {
    throw new AxiosError(JobsErrorMessages.CV_REQUIRED, JobsErrorCodes.CV_REQUIRED);
  }

  // Every rule passed: the answers are stored now (users + consent_records in one statement), then the application.
  await consent?.record();
  const createNewJobApplication = await jobApplicationDAL.addJobApplication(userID, job._id, cv,
    thresholdRecord(job.thresholdCondition, thresholdConfirmed));
  // Salesforce (when on): the application Case (with this application's CV) is queued (salesforceSync.ts).
  await queueSalesforce('application', String(createNewJobApplication._id));

  // A mirrored candidate's row is kept equal to the existing site's Contact (db.ts users_legacy_guard): not marked here.
  if(!user.hasAppliedToJob && !profileLocked){
    await userService.updateUserById(userID,{hasAppliedToJob:true});
  }

  // Service emails (src/mail): the team's notice, and the candidate's confirmation when that event is on.
  await mailStaffNewApplication({ name: `${user.firstName} ${user.lastName}`.trim(), email: user.email, phone: user.phoneNumber, guest: false }, job);
  await mailApplicationReceived(user.email, user.firstName, job);

  return {
    jobApplicationId: createNewJobApplication.jobId,
    cvScope: cv.cvScope,
    // Only when the profile CV changed, so the client can show the new one.
    profileCvFileUrl: cv.newProfileCvFileUrl,
  };
};

//add new guest to salesforce & smoove and create new jobapplication to salesforce
export const guestApplyJob = async (jobRef: Partial<Job> ,guestData: Guest, consent: { marketing: boolean; actor?: string }, thresholdConfirmed = false): Promise<void|string> => {
   // Only the job id is taken from the request; the job itself comes from the DB
   // (the old code put whatever job object the browser sent into the email and Salesforce).
   const jobData = await fetchJobById(String(jobRef?._id ?? ''));
   if (!jobData || !isOpenByLink(jobData)) { // Active, not archived, already published (jobBoard.ts)
     throw new AxiosError(JobsErrorMessages.JOB_NOT_FOUND, JobsErrorCodes.JOB_NOT_FOUND);
   }
   // A job of the existing site takes no applications here (before anything is claimed or stored).
   assertJobTakesApplications(jobData);
   // The apply policy is enforced here, not only by hiding the form (applyPolicy.ts):
   // self-apply jobs go to the employer directly, 'none' needs a sign-in.
   const policy = jobData.applyPolicy ?? DEFAULT_APPLY_POLICY;
   const refusal = checkGuestApply(policy, true);
   if (refusal === 'self-apply-only') {
     throw new AxiosError(JobsErrorMessages.SELF_APPLY_ONLY, JobsErrorCodes.SELF_APPLY_ONLY);
   }
   if (refusal === 'quick-apply-disabled') {
     throw new AxiosError(JobsErrorMessages.QUICK_APPLY_DISABLED, JobsErrorCodes.QUICK_APPLY_DISABLED);
   }
   // Threshold condition (תנאי סף): refused unless confirmed, before the CV upload is claimed (a retry can use it).
   if (thresholdRefusal(jobData.thresholdCondition, thresholdConfirmed)) {
     throw new ThresholdNotConfirmedError(thresholdConditionOf(jobData.thresholdCondition)!);
   }
   const guest: Guest = {
     _id: generateRandomId(),
     fullName: String(guestData?.fullName ?? '').slice(0, 200),
     email: String(guestData?.email ?? '').slice(0, 200),
     phoneNumber: String(guestData?.phoneNumber ?? '').slice(0, 30),
   };
   if (!guest.fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email) || !guest.phoneNumber) {
     throw new AxiosError(JobsErrorMessages.APPLY_JOB, JobsErrorCodes.APPLY_JOB);
   }
   // One quick application per address and job (before the CV upload is claimed or anything stored). A repeat gets
   // the same answer as a new one and nothing is stored, claimed, sent or mailed (security review 24.11.2026, L6:
   // a different answer would tell anyone whether an address applied to a job).
   if (await guestAlreadyApplied(String(jobData._id), guest.email)) {
     if (checkGuestApply(policy, await cvUploadClaimable(guestData?.cvFilePath)) === 'cv-required') {
       throw new AxiosError(JobsErrorMessages.CV_REQUIRED, JobsErrorCodes.CV_REQUIRED);
     }
     return;
   }
   // A CV the visitor did not upload here (or one already taken) counts as no CV.
   const cvFilePath = await claimCvUpload(guestData?.cvFilePath, guest._id, { via: 'guest_application', kind: 'guest', actor: consent.actor });
   if (checkGuestApply(policy, !!cvFilePath) === 'cv-required') {
     throw new AxiosError(JobsErrorMessages.CV_REQUIRED, JobsErrorCodes.CV_REQUIRED);
   }
   guest.cvFilePath = cvFilePath;
   guestData = guest;
   // Stored first, always (owner's rule: nothing is lost or deleted), with the guest's answers to the two boxes
   // under the same guest id. Salesforce gets it when on; a failure there leaves it stored and marked unsent, to
   // be pushed later from the staff screen (services/guestApplications.ts).
   const stored = await storeGuestApplication(guest, String(jobData._id), thresholdRecord(jobData.thresholdCondition, thresholdConfirmed));
   await recordGuestConsent(guest._id, String(jobData._id), guest.email, consent.marketing);
   await queueSalesforce('guest_application', stored.id);
   // The mailing list gets only guests who ticked the marketing box AND whose address is not on the removal list: an
   // unverified form never undoes a removal (security review 24.11.2026, M2).
   if (appConfig.smoove.enableSmoove && await mayPushToList(guest.email, consent.marketing)) {
     await smooveService.ensureSmooveGuest(guestData);
    }
    await mailStaffNewApplication({ name: guest.fullName, email: guest.email, phone: guest.phoneNumber, guest: true }, jobData);
    await mailApplicationReceived(guest.email, guest.fullName, jobData, { guest: true });

}

export const findIfJobsApplicationAlreadyApplied = async (userId: string, jobId: string): Promise<boolean> =>  {
  const application = await jobApplicationDAL.findIfJobsApplicationAlreadyApplied(userId,jobId); // Fetch only _id for optimization
  return !!application;
}

export const findJobsApplictionByUserId = async (userId: string): Promise<string[] | null> => {
  const applications = await jobApplicationDAL.findJobsApplictionByUserId(userId);
  return applications.map((app) => app.jobId.toString());
}

export const findAllJobApplictionsDetailsByUserId = async (userId: string,filterParams?: filterOptions): Promise< {jobs: Job[];
  total: number} | null> => {
  try{
    const applications = await jobApplicationDAL.findAllJobApplictionsDetailsByUserId(userId,filterParams);
    return applications; 
    } catch(error){
      if(isAxiosError(error)){
        throw (error)
      }
      throw new AxiosError(JobsErrorMessages.FETCH_JOB_APPLICATIONS_FAILED, JobsErrorCodes.FETCH_JOB_APPLICATIONS_FAILED);
    }
}

/** security/consent.ts: the terms version accepted now and the marketing answer, for one guest application. */
const recordGuestConsent = async (guestId: string, jobId: string, email: string, marketing: boolean): Promise<void> => {
  await query(
    `WITH g AS (INSERT INTO guest_consents (guest_id, job_id, email, terms_version, terms_accepted_at, marketing_consent, marketing_consent_at)
       VALUES ($1, $2, lower($3), $4, now(), $5, now()) RETURNING guest_id, terms_version, marketing_consent)
     INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
     SELECT 'guest', g.guest_id, g.terms_version, g.marketing_consent, 'guest_apply' FROM g`,
    [guestId, jobId, email, TERMS_VERSION, marketing],
  );
};
