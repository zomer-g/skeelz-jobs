import { applyFlow, apiErrorCode } from '../../utils/analytics';
import { RequestEnum, isCandidateUser, isEmployerUser } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { ActiveJobsResponse, ApplyCvChoice, NearbyJobsResponse, ApplyJobResponse, CreateJobResponse, GetAllJobsResponse, GuestApplyJobResponse } from '../../models/interfaces/Api.interfaces';
import { Guest, JobData } from '../../models/interfaces/Props.interfaces';
import { filterOptions } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';
import { UserService } from './User.service';
import { isString } from '../../utils/utils';
import { requestApplyConsent } from '../../components/consent/ApplyConsentDialog';
import { requestThresholdConfirm } from '../../components/threshold/ThresholdConfirmDialog';
import { i18n } from '../../i18n/I18n';
import useAuthStore from '../../store/Auth.store';


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

    /** One job (GET /api/jobs/:jobId). The job lists carry no employer contact details; this answer has them on a
     *  self-apply job (and for staff). */
    async getJobById(id: string): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(RequestEnum.Get, `${Routes.EDIT_JOB}/${encodeURIComponent(id)}`, {});
    }

    // ---- jobs-management screen (content managers) ----
    async pinJob(id: string, pinned: boolean): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(pinned ? RequestEnum.Post : RequestEnum.Delete, `admin/jobs/${id}/pin`, {});
    }

    /** Bump (הקפצה): once to the top of the list; on a pinned job, above the other pins. */
    async bumpJob(id: string): Promise<JobData | string> {
        return GlobalApiService.generalRequest<JobData>(RequestEnum.Post, `admin/jobs/${id}/bump`, {});
    }

    /** Inline edits: isSponsored, publishDate (+ schedulePublish), status, apply-policy overrides. */
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

    /**
     * תנאי סף: the job's threshold condition as it is NOW (read again, so a changed text is the one confirmed; `known`
     * is used only if that read fails). With a condition the candidate confirms it in the dialog first. Returns the
     * field to send ({ thresholdConfirmed: true } or {}), or null when they cancelled. The server refuses an
     * application to a job with a condition without it (400 threshold_not_confirmed).
     */
    private async confirmThreshold(jobId: string, known?: string | null): Promise<{ thresholdConfirmed?: true } | null> {
        const job = await this.getJobById(jobId);
        const text = (!isString(job) && job ? job.thresholdCondition : known) || '';
        // Analytics: only THAT the job has a condition and what the candidate did — never its text.
        applyFlow.set({ has_threshold: !!text.trim() }, jobId);
        if (!text.trim()) return {};
        applyFlow.step('apply_threshold_shown', 'threshold', {}, jobId);
        const confirmed = await requestThresholdConfirm(text);
        applyFlow.step(confirmed ? 'apply_threshold_confirmed' : 'apply_threshold_dismissed', confirmed ? 'threshold_confirmed' : 'threshold', {}, jobId);
        return confirmed ? { thresholdConfirmed: true } : null;
    }

    /** The request itself, with the funnel's submit / success / error (the code, never the message). */
    private async sendApplication<T>(jobId: string, route: string, body: object): Promise<T | string> {
        applyFlow.step('apply_submit', 'submit', {}, jobId);
        const response = await GlobalApiService.generalRequest<T>(RequestEnum.Post, route, body);
        if (isString(response)) applyFlow.fail(apiErrorCode(response), jobId);
        else applyFlow.succeed(jobId);
        return response;
    }

    async applyJob(jobId: string, cv?: ApplyCvChoice, knownThreshold?: string | null): Promise<ApplyJobResponse | string> {
        // Analytics: a path that applies without the funnel having started still gets a flow (fills in the rest).
        applyFlow.ensure({ job_id: jobId, apply_type: 'registered', apply_mode: 'regular' });
        // An employer-only account never applies (the server refuses it and closes the session); someone who is also a
        // candidate applies as that candidate (several roles per account, 23.11.2026).
        const who = useAuthStore.getState().user;
        if (!isCandidateUser(who) && isEmployerUser(who)) {
            applyFlow.fail('employer_account', jobId);
            return i18n.getTranslations().Employers.CannotApply;
        }
        // A candidate of the existing site applies to this site's jobs like anyone (owner, 23.11.2026); their details
        // stay read-only, so the CV dialog doesn't offer to replace the profile CV. The existing site's jobs take no
        // applications here (the job page says so; the server refuses: 409 job_on_existing_site).
        const me = await UserService.getInstance().getMe();
        const threshold = await this.confirmThreshold(jobId, knownThreshold);
        if (!threshold) return i18n.getTranslations().Threshold.NotConfirmed;
        // Terms never accepted in their current version, or the marketing question never answered: ask once
        // (server/src/security/consent.ts — the server refuses the application with 428 otherwise).
        let answers = {};
        if (!isString(me) && me.consent) {
            const need = { needTerms: !me.consent.termsCurrent, needMarketing: me.consent.marketing === null };
            if (need.needTerms || need.needMarketing) {
                applyFlow.step('apply_terms_shown', 'terms', {}, jobId);
                const a = await requestApplyConsent(need);
                if (!a) {
                    applyFlow.step('apply_terms_declined', 'terms', {}, jobId);
                    return i18n.getTranslations().Terms.NotAccepted;
                }
                answers = a;
            }
        }
        return this.sendApplication<ApplyJobResponse>(jobId,
            `${Routes.JOBS_ROUTES_PREFIX}/${Routes.APPLY_JOB}/${jobId}`,
            { ...(cv ? { cv } : {}), ...answers, ...threshold });
    }

    async guestApplyJob(jobData: JobData, guestData: Guest): Promise<GuestApplyJobResponse | string> {
        const jobId = jobData._id ? String(jobData._id) : '';
        if (jobId) applyFlow.ensure({ job_id: jobId, apply_type: 'guest', apply_mode: 'quick' });
        const threshold = jobId ? await this.confirmThreshold(jobId, jobData.thresholdCondition) : {};
        if (!threshold) return i18n.getTranslations().Threshold.NotConfirmed;
        return this.sendApplication<GuestApplyJobResponse>(jobId,
            `${Routes.JOBS_ROUTES_PREFIX}/${Routes.GUEST_APPLY_JOB}`,
            // The two consent boxes go next to guestData (server/src/security/consent.ts).
            { jobData, guestData: { ...guestData, consent: undefined, marketingConsent: undefined }, consent: guestData.consent === true, marketingConsent: guestData.marketingConsent === true, ...threshold });
    }
}