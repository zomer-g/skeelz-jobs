import * as jobDAL from '../dal/jobDAL.js';
import { CreateJobDTO } from '../dto/createJobDto.js';
import { UpdateJobDto } from '../dto/updateJobDto.js';
import { filterOptions } from '../models/interfaces/general.interface.js';
import { Job } from '../models/schemas/jobs.js';
import appConfig from '../config/appConfig.js';
import * as salesforceService from './salesforceService.js'
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
  if (appConfig.salesforce.enableSalesforce) {
    const jobLocation = await locationService.getLocationByCitySymbol(job.citySymbol);
    await salesforceService.createJobCase(job, jobLocation!);
  }
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
  if (updatedJob && appConfig.salesforce.enableSalesforce) {
    const jobLocation = await locationService.getLocationByCitySymbol(updatedJob.citySymbol);
    await salesforceService.updateJobCase(updatedJob, jobLocation);
  }
  return r;
}

// Board placement (jobs-management screen). Not pushed to Salesforce: pin, visibility and archive live
// only here (docs/jobs-management.md "Integrations").
export const setPinned = (jobId: string, pinned: boolean) => jobDAL.setPinned(jobId, pinned);
export const setArchived = (jobId: string, archived: boolean, by: string) => jobDAL.setArchived(jobId, archived, by);
export const countApplications = (jobId: string) => jobDAL.countApplications(jobId);
