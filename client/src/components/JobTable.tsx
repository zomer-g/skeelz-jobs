import React, { useEffect, useState } from 'react';
import { ApplyPolicy, JobData } from '../models/interfaces/Props.interfaces';
import { FlagBox, jobFlagItems } from './jobsAdmin/JobFlags';
import { JobStatus } from '../models/interfaces/General.interfaces';
import { i18n } from '../i18n/I18n';
import { formatDay, fromDateInput, isFutureDate, maxScheduleInput, toDateInput } from '../utils/jobBoard';

/**
 * Jobs-management table (content managers). One row per job, every board setting editable in place:
 * bump and pin (side by side), status (the only public/hidden switch: only Active jobs are on the site),
 * publish date (incl. scheduling), one column per setting checkbox (sponsored, direct / quick apply, CV rules;
 * the name is in the sticky header row, not repeated in every row), and edit / delete (archive) / restore.
 * Plain <table> with real controls: every control has an accessible name that includes the job title.
 */
export interface JobTableProps {
    jobs: JobData[];
    busyId?: string | null;
    onPin: (job: JobData, pinned: boolean) => void;
    /** Bump (הקפצה): once to the top of the list (on a pinned job: above the other pins). */
    onBump: (job: JobData) => void;
    /** Site-wide apply defaults, so a setting equal to the default is stored as "follow the default". */
    applyDefaults?: ApplyPolicy;
    /** false for a placement coordinator: the apply-setting boxes are read-only (sponsored stays editable). */
    canEditApplySettings?: boolean;
    onBoardChange: (job: JobData, values: Partial<JobData>) => Promise<boolean>;
    onEdit: (job: JobData) => void;
    onDelete: (job: JobData) => void;
    onRestore: (job: JobData) => void;
}

const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);


/** Publish date cell: date input + save. A future date needs the "schedule" box ticked. */
const PublishDateCell: React.FC<{ job: JobData; disabled?: boolean; onSave: (values: Partial<JobData>) => Promise<boolean> }> = ({ job, disabled, onSave }) => {
    const t = i18n.getTranslations().JobsAdmin;
    const current = toDateInput(job.publishDate);
    const [value, setValue] = useState(current);
    const [schedule, setSchedule] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { setValue(current); setSchedule(false); setError(''); }, [current]);
    const date = value ? fromDateInput(value) : null;
    const future = !!date && isFutureDate(date);
    const changed = value !== current;
    const errId = `date-err-${job._id}`;

    const save = async () => {
        if (!date) { setError(t.DateInvalid); return; }
        if (value > maxScheduleInput()) { setError(t.DateTooFar); return; }
        if (future && !schedule) { setError(t.ScheduleConfirm); return; }
        setError('');
        const ok = await onSave({ publishDate: date, ...(future ? { schedulePublish: true } : {}) });
        if (!ok) setValue(current);
    };

    return (
        <div className="jobs-admin-date">
            <input
                type="date"
                className="form-control form-control-sm"
                value={value}
                max={maxScheduleInput()}
                aria-label={fill(t.DateLabel, { title: job.title })}
                aria-invalid={!!error}
                aria-describedby={error ? errId : undefined}
                disabled={disabled}
                onChange={(e) => { setValue(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && changed) { e.preventDefault(); void save(); } }}
            />
            {changed && future && (
                <label className="jobs-admin-date__schedule">
                    <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
                    <span>{t.SchedulePublish}</span>
                </label>
            )}
            {changed && (
                <button type="button" className="board-pill board-pill--small" disabled={disabled} onClick={() => void save()}>
                    {t.SaveDate}
                </button>
            )}
            {error && <div id={errId} role="alert" className="jobs-admin-date__error">{error}</div>}
        </div>
    );
};

const JobTable: React.FC<JobTableProps> = ({ jobs, busyId, onPin, onBump, applyDefaults, canEditApplySettings = true, onBoardChange, onEdit, onDelete, onRestore }) => {
    const tr = i18n.getTranslations();
    const t = tr.JobsAdmin;
    const statusLabels: Record<string, string> = {
        [JobStatus.ACTIVE]: tr.Jobs.Active,
        [JobStatus.SUSPENDED]: tr.Jobs.Suspended,
        [JobStatus.CLOSED]: tr.Jobs.Closed,
    };

    // Column headers of the setting checkboxes (same order as each row's cells).
    const flagHeaders = jobFlagItems({}, applyDefaults, () => undefined);

    if (!jobs.length) return <p className="jobs-admin__empty" role="status">{t.NoJobs}</p>;

    return (
        <div className="jobs-admin-table__wrap">
            <table className="jobs-admin-table">
                <caption className="visually-hidden">{t.Title}</caption>
                <thead>
                    <tr>
                        <th scope="col">{t.ColPin}</th>
                        <th scope="col">{t.ColJob}</th>
                        <th scope="col">{t.ColStatus}</th>
                        <th scope="col">{t.ColPublishDate}</th>
                        {flagHeaders.map((h) => <th key={h.key} scope="col" className="jobs-admin-table__flag-col">{h.text}</th>)}
                        <th scope="col">{t.ColActions}</th>
                    </tr>
                </thead>
                <tbody>
                    {jobs.map((job) => {
                        const id = job._id!;
                        const busy = busyId === id;
                        const archived = !!job.deletedAt;
                        const pinned = !!job.pinnedAt;
                        // Imported from the existing site: read-only (the server refuses any change, 409 job_read_only).
                        const locked = !!job.importedFromLive;
                        const scheduled = isFutureDate(job.publishDate);
                        const title = job.title;
                        return (
                            <tr key={id} className={`${archived ? 'is-archived' : ''} ${pinned ? 'is-pinned' : ''} ${locked ? 'is-locked' : ''}`} aria-busy={busy}>
                                <td>
                                    {locked && (
                                        <span className="jobs-admin-lock" title={t.ImportedHint} aria-hidden="true"><i className="bi bi-lock" /></span>
                                    )}
                                    {!archived && !locked && (
                                        <div className="jobs-admin-pin">
                                            {/* Bump (הקפצה): once to the top. Pin (נעץ): stays first until unpinned. */}
                                            <button
                                                type="button"
                                                className="board-pill board-pill--icon"
                                                aria-label={`${pinned ? t.BumpPinned : t.Bump}: ${title}`}
                                                title={pinned ? t.BumpPinned : t.Bump}
                                                disabled={busy}
                                                onClick={() => onBump(job)}
                                            >
                                                <i className="bi bi-arrow-up" aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                className={`board-pill board-pill--icon ${pinned ? 'board-pill--active' : ''}`}
                                                aria-pressed={pinned}
                                                aria-label={`${t.Pin}: ${title}`}
                                                title={pinned ? t.PinAgain : t.Pin}
                                                disabled={busy}
                                                onClick={() => onPin(job, !pinned)}
                                            >
                                                <i className={`bi ${pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'}`} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}
                                </td>
                                <th scope="row" className="jobs-admin-table__job">
                                    <span className="jobs-admin-table__title">{title}</span>
                                    <span className="jobs-admin-table__meta">
                                        {job.companyName}{job.location?.city ? ` · ${job.location.city}` : ''}{job.jobId ? ` · #${job.jobId}` : ''}
                                    </span>
                                    <span className="jobs-admin-badges">
                                        {pinned && <span className="jobs-admin-badge jobs-admin-badge--pin"><i className="bi bi-pin-angle-fill" aria-hidden="true" /> {fill(t.PinnedSince, { date: formatDay(job.pinnedAt) })}</span>}
                                        {!pinned && job.bumpedAt && <span className="jobs-admin-badge">{fill(t.BumpedSince, { date: formatDay(job.bumpedAt) })}</span>}
                                        {scheduled && <span className="jobs-admin-badge jobs-admin-badge--scheduled" title={t.ScheduledHint}>{t.Scheduled}</span>}
                                        {archived && <span className="jobs-admin-badge jobs-admin-badge--archived">{fill(t.ArchivedBy, { date: formatDay(job.deletedAt) })}</span>}
                                        {locked && <span className="jobs-admin-badge jobs-admin-badge--imported" title={t.ImportedHint}><i className="bi bi-lock" aria-hidden="true" /> {t.Imported}</span>}
                                    </span>
                                </th>
                                <td>
                                    <select
                                        className="form-select form-select-sm"
                                        aria-label={fill(t.StatusLabel, { title })}
                                        value={job.status}
                                        disabled={busy || archived || locked}
                                        onChange={(e) => void onBoardChange(job, { status: e.target.value })}
                                    >
                                        {Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                </td>
                                <td><PublishDateCell job={job} disabled={busy || archived || locked} onSave={(v) => onBoardChange(job, v)} /></td>
                                {jobFlagItems(job, applyDefaults, (patch) => void onBoardChange(job, patch)).map((item) => (
                                    <td key={item.key} className="jobs-admin-table__flag">
                                        <FlagBox id={`flag-${id}-${item.key}`} item={item} disabled={busy || archived || locked || (!canEditApplySettings && item.key !== 'sponsored')}
                                            accessibleName={`${item.text}: ${title}`} showText={false} />
                                    </td>
                                ))}
                                <td>
                                    <div className="jobs-admin-actions">
                                        {locked ? (
                                            <a className="board-pill board-pill--icon" href={`/job/${id}`} target="_blank" rel="noopener noreferrer"
                                                aria-label={fill(t.ViewOnBoardLabel, { title })} title={t.ViewOnBoard}>
                                                <i className="bi bi-box-arrow-up-left" aria-hidden="true" />
                                            </a>
                                        ) : archived ? (
                                            <button type="button" className="board-pill board-pill--small" disabled={busy}
                                                aria-label={fill(t.RestoreLabel, { title })} onClick={() => onRestore(job)}>
                                                <i className="bi bi-arrow-counterclockwise" aria-hidden="true" /> {t.Restore}
                                            </button>
                                        ) : (
                                            <>
                                                {/* Icon buttons (a short row); the name is in aria-label and the tooltip. */}
                                                <button type="button" className="board-pill board-pill--icon" disabled={busy}
                                                    aria-label={fill(t.EditLabel, { title })} title={t.Edit} onClick={() => onEdit(job)}>
                                                    <i className="bi bi-pencil" aria-hidden="true" />
                                                </button>
                                                <a className="board-pill board-pill--icon" href={`/job/${id}`} target="_blank" rel="noopener noreferrer"
                                                    aria-label={fill(t.ViewOnBoardLabel, { title })} title={t.ViewOnBoard}>
                                                    <i className="bi bi-box-arrow-up-left" aria-hidden="true" />
                                                </a>
                                                <button type="button" className="board-pill board-pill--icon board-pill--danger" disabled={busy}
                                                    aria-label={fill(t.DeleteLabel, { title })} title={t.Delete} onClick={() => onDelete(job)}>
                                                    <i className="bi bi-trash" aria-hidden="true" />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

export { fill };
export default JobTable;
