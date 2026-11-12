import * as jobApplicationDAL from '../dal/jobApplicationDAL.js';
import { AxiosError, isAxiosError } from 'axios';
import { AuthErrorCodes, AuthErrorMessages, JobsErrorCodes, JobsErrorMessages } from '../i18n/i18n.js';
import * as emailService from './emailService.js';
import { generateApplyJobEmail, generateGuestApplyJobEmail } from '../utils/emailTemplates.js';
import * as salesforceService from './salesforceService.js'
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
import { claimCvUpload } from './s3Service.js';
import IJobApplication from '../models/schemas/jobApplication.js';
import { checkGuestApply, DEFAULT_APPLY_POLICY } from '../models/schemas/applyPolicy.js';
import { parseCvChoice, resolveApplicationCv, sendApplicationToSalesforce } from './applicationCv.js';




/**
 * A registered candidate applies. `rawCvChoice` is the request's `cv` field
 * (see services/applicationCv.ts); without it the profile CV is used.
 */
export const addJobApplication = async (userID: string, jobId: string, rawCvChoice?: unknown) => {
  const cvChoice = parseCvChoice(rawCvChoice);
  const user = await getUserById(userID);

  if (!user) {
    throw new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED);
  }
  const job = await fetchJobById(jobId);
  
  if (!job || !job._id || !isOpenByLink(job)) { // Active, not archived, already published (jobBoard.ts)
    throw new AxiosError(JobsErrorMessages.JOB_NOT_FOUND, JobsErrorCodes.JOB_NOT_FOUND);
  }

  const alreadyApplied = await findIfJobsApplicationAlreadyApplied(user._id.toString(), job._id.toString());
  if (alreadyApplied) {
    throw new AxiosError(JobsErrorMessages.ALREADY_APPLIED, JobsErrorCodes.ALREADY_APPLIED);
  }

  const cv = await resolveApplicationCv(cvChoice, { id: user._id.toString(), cvFileUrl: user.cvFileUrl }, {
    claimUpload: claimCvUpload,
    setProfileCv: userService.setProfileCv,
  });

  const createNewJobApplication = await jobApplicationDAL.addJobApplication(userID, job._id, cv);
  if (appConfig.salesforce.enableSalesforce) {
    await sendApplicationToSalesforce(createNewJobApplication, {
      createCase: () => salesforceService.createJobApplicationCase(createNewJobApplication),
      attachCv: (cvFileUrl, caseId) => salesforceService.attachCvToApplicationCase(cvFileUrl, caseId, createNewJobApplication._id),
    });
  }

  if(!user.hasAppliedToJob){
    await userService.updateUserById(userID,{hasAppliedToJob:true});
  }

  const { subject, text } = generateApplyJobEmail(user, job);
  await emailService.sendEmail(appConfig.applicationNotificationEmail, subject, text, true);

  return {
    jobApplicationId: createNewJobApplication.jobId,
    cvScope: cv.cvScope,
    // Only when the profile CV changed, so the client can show the new one.
    profileCvFileUrl: cv.newProfileCvFileUrl,
  };
};

//add new guest to salesforce & smoove and create new jobapplication to salesforce
export const guestApplyJob = async (jobRef: Partial<Job> ,guestData: Guest): Promise<void|string> => {
   // Only the job id is taken from the request; the job itself comes from the DB
   // (the old code put whatever job object the browser sent into the email and Salesforce).
   const jobData = await fetchJobById(String(jobRef?._id ?? ''));
   if (!jobData || !isOpenByLink(jobData)) { // Active, not archived, already published (jobBoard.ts)
     throw new AxiosError(JobsErrorMessages.JOB_NOT_FOUND, JobsErrorCodes.JOB_NOT_FOUND);
   }
   // The admin apply policy is enforced here, not only by hiding the form.
   const policy = jobData.applyPolicy ?? DEFAULT_APPLY_POLICY;
   if (checkGuestApply(policy, true) === 'quick-apply-disabled') {
     throw new AxiosError(JobsErrorMessages.QUICK_APPLY_DISABLED, JobsErrorCodes.QUICK_APPLY_DISABLED);
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
   // A CV the visitor did not upload here (or one already taken) counts as no CV.
   const cvFilePath = await claimCvUpload(guestData?.cvFilePath, guest._id);
   if (checkGuestApply(policy, !!cvFilePath) === 'cv-required') {
     throw new AxiosError(JobsErrorMessages.CV_REQUIRED, JobsErrorCodes.CV_REQUIRED);
   }
   guest.cvFilePath = cvFilePath;
   guestData = guest;
    const newJobApp: IJobApplication = {
      _id: generateRandomId(),
      userId: guestData._id,
      jobId: jobData._id,
    };
   if (appConfig.salesforce.enableSalesforce) {
    await salesforceService.createContactAsGuest(guestData);
    if (guestData.cvFilePath) {
      await salesforceService.uploadCVFromS3ToSalesforce(guestData.cvFilePath, guestData._id);
    }
    await salesforceService.createJobApplicationCase(newJobApp);
   }
   if (appConfig.smoove.enableSmoove) {
     await smooveService.ensureSmooveGuest(guestData);
    }
    const { subject, text } = generateGuestApplyJobEmail(guestData, jobData);
    await emailService.sendEmail(appConfig.applicationNotificationEmail, subject, text, true);

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
