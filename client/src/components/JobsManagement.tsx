import React, { useCallback, useEffect, useRef, useState } from 'react';
import { JobStatus } from '../models/interfaces/General.interfaces';
import { ApplyPolicy, JobData, filterOptions } from '../models/interfaces/Props.interfaces';
import SettingsService from '../services/api/Settings.service';
import { JobService } from '../services/api/Job.service';
import { isString } from '../utils/utils';
import useModalStore from '../store/Modal.store';
import { i18n } from '../i18n/I18n';
import JobTable, { fill } from './JobTable';
import useToastStore from '../store/Toast.store';
import CreateOrEditJobContainer from './CreateOrEditJobContainer';
import { useNavigate } from 'react-router-dom';
import { ClientRoutes } from '../i18n/ClientRoutes.enum';
import ConfirmDialog from './jobsAdmin/ConfirmDialog';
import useAuthStore from '../store/Auth.store';
import { canManageContent } from '../i18n/General.enums';

/**
 * /jobs-management (content managers only; server gates: contentManagerOnly). One screen for jobs:
 * search + filters, and per job: bump (once to the top), pin (stays first), status, publish date, and compact
 * checkboxes, one column each (sponsored, direct / quick apply, CV required), edit, delete (archive, with undo) and restore. Rules: docs/jobs-management.md.
 */
type Order = 'board' | 'publishNew' | 'publishOld' | 'updated' | 'title';
const ORDER_TO_SORT: Record<Order, { sortField?: string; sortOrder?: string }> = {
    board: {},
    publishNew: { sortField: 'publishDate', sortOrder: 'desc' },
    publishOld: { sortField: 'publishDate', sortOrder: 'asc' },
    updated: { sortField: 'updatedAt', sortOrder: 'desc' },
    title: { sortField: 'title', sortOrder: 'asc' },
};

interface Filters {
    status: '' | JobStatus;
    sponsored: boolean;
    pinned: boolean;
    scheduled: boolean;
    view: 'live' | 'only' | 'include';
    order: Order;
}
const EMPTY: Filters = { status: '', sponsored: false, pinned: false, scheduled: false, view: 'live', order: 'board' };
const PAGE_SIZE = 20;

const JobsManagement: React.FC = () => {
    const tr = i18n.getTranslations();
    const t = tr.JobsAdmin;
    // Placement coordinators manage jobs but not the apply settings or API keys (content managers and admins).
    const { user } = useAuthStore();
    const isContentManager = canManageContent(user?.role);
    const dir = i18n.isRTL() ? 'rtl' : 'ltr';
    const { initModal } = useModalStore();
    const { showToast } = useToastStore();
    const navigate = useNavigate();

    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [filters, setFilters] = useState<Filters>(EMPTY);
    const [page, setPage] = useState(1);
    const [jobs, setJobs] = useState<JobData[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [toDelete, setToDelete] = useState<{ job: JobData; applications: number | null } | null>(null);
    const [undo, setUndo] = useState<JobData | null>(null);
    const [announce, setAnnounce] = useState('');
    const reqSeq = useRef(0);
    const undoRef = useRef<HTMLButtonElement>(null);
    // After a delete the row is gone: focus moves to the Undo button.
    useEffect(() => { if (undo) undoRef.current?.focus(); }, [undo]);

    useEffect(() => {
        const h = setTimeout(() => setDebounced(search.trim()), 350);
        return () => clearTimeout(h);
    }, [search]);
    useEffect(() => { setPage(1); }, [debounced, filters]);

    const fetchJobs = useCallback(async () => {
        const seq = ++reqSeq.current;
        const f: filterOptions & Record<string, unknown> = { page, limit: PAGE_SIZE, ...ORDER_TO_SORT[filters.order] };
        if (debounced) f.inputValue = debounced;
        if (filters.status) f.jobStatus = [filters.status];
        if (filters.sponsored) f.isSponsored = true;
        if (filters.pinned) f.pinned = true;
        if (filters.scheduled) f.scheduled = true;
        if (filters.view !== 'live') f.archived = filters.view;
        const res = await JobService.getInstance().adminFetchAllJobs(f);
        if (seq !== reqSeq.current) return; // a newer request is on its way
        setLoading(false);
        if (isString(res)) { showToast(res, 'error'); return; }
        setJobs(res.jobs);
        setTotal(res.total);
        setAnnounce(fill(t.ResultCount, { n: res.total }));
    }, [page, debounced, filters]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { void fetchJobs(); }, [fetchJobs]);

    const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    /** Runs one change, puts the server's copy of the job in the row, refreshes the order. */
    const run = async (job: JobData, call: () => Promise<JobData | string>, okText: string): Promise<boolean> => {
        setBusyId(job._id!);
        const res = await call();
        setBusyId(null);
        if (isString(res)) { showToast(res || t.ErrorToast, 'error'); return false; }
        showToast(okText, 'success');
        setAnnounce(okText);
        await fetchJobs();
        return true;
    };

    const onPin = (job: JobData, pinned: boolean) =>
        void run(job, () => JobService.getInstance().pinJob(job._id!, pinned), pinned ? t.PinnedToast : t.UnpinnedToast);

    const onBump = (job: JobData) =>
        void run(job, () => JobService.getInstance().bumpJob(job._id!), t.BumpedToast);

    // Site-wide apply defaults: a checkbox set back to the default value is stored as "follow the default".
    const [applyDefaults, setApplyDefaults] = useState<ApplyPolicy | undefined>();
    const loadApplyDefaults = useCallback(async () => {
        const r = await SettingsService.getInstance().getApplyPolicy();
        if (!isString(r)) setApplyDefaults(r);
    }, []);
    useEffect(() => { void loadApplyDefaults(); }, [loadApplyDefaults]);

    const onBoardChange = (job: JobData, values: Partial<JobData>) =>
        run(job, () => JobService.getInstance().updateJobBoard(job._id!, values), 'publishDate' in values ? t.DateSaved : t.SavedToast);

    const onDelete = async (job: JobData) => {
        setToDelete({ job, applications: null });
        const r = await JobService.getInstance().applicationsCount(job._id!);
        setToDelete((cur) => (cur && cur.job._id === job._id ? { job, applications: isString(r) ? null : r.count } : cur));
    };

    const confirmDelete = async () => {
        if (!toDelete) return;
        const job = toDelete.job;
        setToDelete(null);
        const ok = await run(job, () => JobService.getInstance().archiveJob(job._id!, true), fill(t.DeletedToast, { title: job.title }));
        if (ok) setUndo(job);
    };

    const onRestore = async (job: JobData) => {
        const ok = await run(job, () => JobService.getInstance().archiveJob(job._id!, false), t.RestoredToast);
        if (ok && undo?._id === job._id) setUndo(null);
    };

    const openForm = (job?: JobData) => {
        initModal({
            active: true,
            modalTitle: job ? tr.JobDetails.EditJob : tr.JobDetails.UploadNewJob,
            modalBody: <CreateOrEditJobContainer
                initialJobData={job}
                onJobUploaded={async () => { initModal({ active: false }); await fetchJobs(); }}
            />,
            modalStyle: { dialogClassName: 'max-width-72-06rem', headerClass: 'bg-color-light-green', titleClass: 'font-RubikBold fs-4', bodyClass: 'p-0' },
        });
    };

    const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY) || !!search;

    return (
        <div dir={dir} className="board-frame jobs-admin">
            <div className="jobs-admin__head">
                <h1 className="font-EzerRegularLoft display-6 m-0">{t.Title}</h1>
                <div className="jobs-admin__head-actions">
                    <button type="button" className="board-pill" onClick={() => navigate(ClientRoutes.JobSubmissions)}>
                        <i className="bi bi-inbox" aria-hidden="true" /> {t.Submissions}
                    </button>
                    <button type="button" className="board-pill board-pill--employer" onClick={() => openForm()}>
                        <i className="bi bi-plus-lg" aria-hidden="true" /> {t.AddJob}
                    </button>
                </div>
            </div>
            <p className="jobs-admin__intro">{t.Intro}</p>

            <form className="jobs-admin-filters" role="search" aria-label={t.Filters} onSubmit={(e) => { e.preventDefault(); setDebounced(search.trim()); }}>
                <div className="jobs-admin-filters__field jobs-admin-filters__field--search">
                    <label htmlFor="jobs-admin-search">{t.Search}</label>
                    <input id="jobs-admin-search" type="search" className="form-control" value={search}
                        placeholder={t.SearchPlaceholder} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="jobs-admin-filters__field">
                    <label htmlFor="jobs-admin-status">{t.Status}</label>
                    <select id="jobs-admin-status" className="form-select" value={filters.status}
                        onChange={(e) => setFilter('status', e.target.value as Filters['status'])}>
                        <option value="">{t.AllStatuses}</option>
                        <option value={JobStatus.ACTIVE}>{tr.Jobs.Active}</option>
                        <option value={JobStatus.SUSPENDED}>{tr.Jobs.Suspended}</option>
                        <option value={JobStatus.CLOSED}>{tr.Jobs.Closed}</option>
                    </select>
                </div>
                <div className="jobs-admin-filters__field">
                    <label htmlFor="jobs-admin-view">{t.View}</label>
                    <select id="jobs-admin-view" className="form-select" value={filters.view}
                        onChange={(e) => setFilter('view', e.target.value as Filters['view'])}>
                        <option value="live">{t.ViewLive}</option>
                        <option value="only">{t.ViewArchived}</option>
                        <option value="include">{t.ViewAll}</option>
                    </select>
                </div>
                <div className="jobs-admin-filters__field">
                    <label htmlFor="jobs-admin-order">{t.Order}</label>
                    <select id="jobs-admin-order" className="form-select" value={filters.order}
                        onChange={(e) => setFilter('order', e.target.value as Order)}>
                        <option value="board">{t.OrderBoard}</option>
                        <option value="publishNew">{t.OrderPublishNew}</option>
                        <option value="publishOld">{t.OrderPublishOld}</option>
                        <option value="updated">{t.OrderUpdated}</option>
                        <option value="title">{t.OrderTitle}</option>
                    </select>
                </div>
                <fieldset className="jobs-admin-filters__checks">
                    <legend className="visually-hidden">{t.Filters}</legend>
                    {([['pinned', t.PinnedOnly], ['sponsored', t.SponsoredOnly], ['scheduled', t.ScheduledOnly]] as const).map(([k, label]) => (
                        <label key={k} className="jobs-admin-check">
                            <input type="checkbox" checked={filters[k]} onChange={(e) => setFilter(k, e.target.checked)} />
                            <span>{label}</span>
                        </label>
                    ))}
                </fieldset>
                {filtersActive && (
                    <button type="button" className="jobs-admin-link" onClick={() => { setFilters(EMPTY); setSearch(''); setDebounced(''); }}>
                        {t.ClearFilters}
                    </button>
                )}
            </form>

            {undo && (
                <div className="jobs-admin-undo" role="status">
                    <span>{fill(t.DeletedToast, { title: undo.title })}</span>
                    <button ref={undoRef} type="button" className="board-pill board-pill--small" onClick={() => void onRestore(undo)}>
                        <i className="bi bi-arrow-counterclockwise" aria-hidden="true" /> {t.Undo}
                    </button>
                    <button type="button" className="jobs-admin-undo__close" aria-label={t.Cancel} onClick={() => setUndo(null)}>
                        <i className="bi bi-x-lg" aria-hidden="true" />
                    </button>
                </div>
            )}

            <div className="visually-hidden" aria-live="polite">{announce}</div>
            <div className="jobs-admin__count">{loading ? t.Loading : fill(t.ResultCount, { n: total })}</div>

            {!loading && (
                <JobTable jobs={jobs} busyId={busyId} onPin={onPin} onBump={onBump} applyDefaults={applyDefaults} canEditApplySettings={isContentManager} onBoardChange={onBoardChange}
                    onEdit={(j) => openForm(j)} onDelete={(j) => void onDelete(j)} onRestore={(j) => void onRestore(j)} />
            )}

            {pages > 1 && (
                <nav className="jobs-admin-pages" aria-label={fill(t.PageOf, { page, pages })}>
                    <button type="button" className="board-pill board-pill--small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t.Previous}</button>
                    <span aria-current="page">{fill(t.PageOf, { page, pages })}</span>
                    <button type="button" className="board-pill board-pill--small" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t.Next}</button>
                </nav>
            )}

            <ConfirmDialog
                open={!!toDelete}
                title={t.ConfirmDeleteTitle}
                confirmLabel={t.ConfirmDelete}
                cancelLabel={t.Cancel}
                danger
                onConfirm={() => void confirmDelete()}
                onCancel={() => setToDelete(null)}
            >
                {toDelete && (
                    <>
                        <p>{fill(t.ConfirmDeleteBody, { title: toDelete.job.title })}</p>
                        {toDelete.applications !== null && toDelete.applications > 0 && (
                            <p className="fw-bold">{fill(t.ConfirmDeleteApplications, { n: toDelete.applications })}</p>
                        )}
                    </>
                )}
            </ConfirmDialog>

        </div>
    );
};

export default JobsManagement;
