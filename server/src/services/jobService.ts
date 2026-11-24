import * as jobDAL from '../dal/jobDAL.js';
import { CreateJobDTO } from '../dto/createJobDto.js';
import { UpdateJobDto } from '../dto/updateJobDto.js';
import { filterOptions } from '../models/interfaces/general.interface.js';
import { Job } from '../models/schemas/jobs.js';
import appConfig from '../config/appConfig.js';
import { queueSalesforce } from './salesforceSync.js'
import * as locationService from '../services/locationService.js';
import { StringBoolean } from '../models/enums.js';



export const fetchAllJobs = async (filterParams?: filterOptions): Promise<{
  jobs: Job[];
  total: number
}> => {
  return await jobDAL.findAllJobs(filterParams || {});
}

/** Map search: active jobs within radiusKm of a point, nearest first. */
export const getActiveJobsNear = async (lat: number, lng: number, radiusKm: number, filterParams?: filterOptions) =>
  jobDAL.findActiveJobsNear(lat, lng, radiusKm, filterParams || {});


export const getActiveJobsWithoutComments = async (
  filterParams?: filterOptions,
): Promise<{ jobs: Job[]; total: number }> => {
  let sponsoredJobs: Job[] = [];
  let sponsoredIds: string[] = [];
  let jobs: Job[] = [];
  let total = 0;

  if (filterParams?.jobCitySymbol) {
    filterParams.jobCitySymbol = filterParams.jobCitySymbol.map(Number);
  }
  const includeRandomSponsoredJobs = String(filterParams?.includeRandomSponsoredJobs) === StringBoolean.True;
  if (includeRandomSponsoredJobs) {
    sponsoredJobs = await jobDAL.getRandomSponsoredJobs(2,filterParams);
    sponsoredIds = sponsoredJobs.map(job => job._id.toString());
  }
    const result = await jobDAL.findActiveJobsWithoutComments(filterParams, sponsoredIds);
    // Pinned jobs stay on top (docs/jobs-management.md); the random "hot" jobs (never pinned ones) come right after them.
    const pinnedCount = result.jobs.findIndex((j) => !j.pinnedAt);
    const cut = pinnedCount === -1 ? result.jobs.length : pinnedCount;
    jobs = [...result.jobs.slice(0, cut), ...sponsoredJobs, ...result.jobs.slice(cut)];
    total = result.total;

  return { jobs, total };
};

export const fetchJobById = async (jobId: string, opts: { withComments?: boolean } = {}): Promise<Job | null> => {
  return await jobDAL.findJobByJobId(jobId, opts);
}

export const createJob = async (createJobDto: CreateJobDTO, source: 'screen' | 'integration' = 'screen'): Promise<any> => {
  const job = await jobDAL.createJob(createJobDto, source);
  // Salesforce (when on): queued; jobs imported from the existing site are never queued (salesforceSync.ts).
  await queueSalesforce('job', String(job._id));
  return job;
}

export const updateJobById = async (jobId: string, updateJobDto: UpdateJobDto, source: jobDAL.UpdateSource = 'screen'): Promise<any> => {
  const r = await updateJobByIdDetailed(jobId, updateJobDto, source);
  return r?.job ?? null;
}

/** Same as updateJobById, plus the field names an integration was not allowed to change. */
export const updateJobByIdDetailed = async (jobId: string, updateJobDto: UpdateJobDto, source: jobDAL.UpdateSource = 'screen') => {
  const r = await jobDAL.updateJobByIdDetailed(jobId, updateJobDto, source);
  const updatedJob = r?.job;
  if (updatedJob) await queueSalesforce('job', String(updatedJob._id));
  return r;
}

// Board placement (jobs-management screen). Pin and bump live only here (docs/jobs-management.md "Integrations");
// an archive (removed from the board) and a restore reach Salesforce as the job's site status (PStatus__c Closed).
export const setPinned = (jobId: string, pinned: boolean) => jobDAL.setPinned(jobId, pinned);
export const bumpJob = (jobId: string) => jobDAL.bumpJob(jobId);
export const setArchived = async (jobId: string, archived: boolean, by: string) => {
  const job = await jobDAL.setArchived(jobId, archived, by);
  if (job) await queueSalesforce('job', jobId);
  return job;
};
export const countApplications = (jobId: string) => jobDAL.countApplications(jobId);
