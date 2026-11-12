import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { ActiveJobsResponse, ApplyCvChoice, NearbyJobsResponse, ApplyJobResponse, CreateJobResponse, GetAllJobsResponse, GuestApplyJobResponse } from '../../models/interfaces/Api.interfaces';
import { Guest, JobData } from '../../models/interfaces/Props.interfaces';
import { filterOptions } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';


export class JobService {

    private static instance: JobService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new JobService();
        }
        return this.instance;
    }

    async adminFetchAllJobs(filterOptions?: filterOptions): Promise<GetAllJobsResponse | string> {
        const response: string | GetAllJobsResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.ADMIN_GET_ALL_JOBS}`,
                { filterOptions },
            );
        return response;
    }

    async getActiveJobs(filterOptions?: filterOptions): Promise<ActiveJobsResponse | string> {
        const response: string | ActiveJobsResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.GET_ACTIVE_JOBS}`,
                { filterOptions },
            );
        return response;
    }

    async getJobsNear(lat: number, lng: number, radiusKm: number, filterOptions?: filterOptions): Promise<NearbyJobsResponse | string> {
        return GlobalApiService.generalRequest<NearbyJobsResponse>(
            RequestEnum.Get,
            `${Routes.GET_JOBS_NEAR}`,
            { lat, lng, radiusKm, filterOptions },
        );
    }

    async addNewJob(newJob: Omit<JobData, '_id'>): Promise<CreateJobResponse | string> {
        const response:
            | string
            | CreateJobResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.ADD_JOB}`,
                newJob,
            );
        return response;
    }

    async editJob(id: string, values: JobData): Promise<CreateJobResponse | string> {
        const { _id, ...restValues } = values;
        const response:
            | string
            | CreateJobResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Patch,
                `${Routes.EDIT_JOB}/${_id}`,
                restValues,
            );
        return response;
    }

    // ---- jobs-management screen (content managers) ----
    async pinJob(id: string, pinned: boolean): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(pinned ? RequestEnum.Post : RequestEnum.Delete, `admin/jobs/${id}/pin`, {});
    }

    /** Inline edits: isPublic, isSponsored, publishDate (+ schedulePublish), status, apply-policy overrides. */
    async updateJobBoard(id: string, values: Partial<JobData>): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(RequestEnum.Patch, `admin/jobs/${id}/board`, values);
    }

    async archiveJob(id: string, archived: boolean): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(RequestEnum.Post, `admin/jobs/${id}/${archived ? 'archive' : 'restore'}`, {});
    }

    async applicationsCount(id: string): Promise<{ count: number } | string> {
        return GlobalApiService.generalRequest<{ count: number }>(RequestEnum.Get, `admin/jobs/${id}/applications-count`, {});
    }

    async getJobApplications(userId: string, filterOptions?: filterOptions): Promise<GetAllJobsResponse | string> {
        const response:
            | string
            | GetAllJobsResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.GET_JOB_APPLICATIONS}/${userId}`,
                { filterOptions },
            );
        return response;
    }

    async applyJob(jobId: string, cv?: ApplyCvChoice): Promise<ApplyJobResponse | string> {
        const response:
            | string
            | ApplyJobResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.JOBS_ROUTES_PREFIX}/${Routes.APPLY_JOB}/${jobId}`,
                cv ? { cv } : {},
            );
        return response;
    }

    async guestApplyJob(jobData: JobData, guestData: Guest): Promise<GuestApplyJobResponse | string> {
        const response:
            | string
            | ApplyJobResponse =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.JOBS_ROUTES_PREFIX}/${Routes.GUEST_APPLY_JOB}`,
                {jobData,guestData},
            );
        return response;
    }
}