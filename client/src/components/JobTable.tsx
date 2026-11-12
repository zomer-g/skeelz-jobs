import React, { useEffect, useState } from 'react';
import { JobData } from '../models/interfaces/Props.interfaces';
import { JobStatus } from '../models/interfaces/General.interfaces';
import { i18n } from '../i18n/I18n';
import { formatDay, fromDateInput, isFutureDate, maxScheduleInput, toDateInput } from '../utils/jobBoard';
import { CrownIcon } from '../icons';

/**
 * Jobs-management table (content managers). One row per job, every board setting editable in place:
 * pin to top, status, publish date (incl. scheduling), public/private, crown (sponsored), apply-policy
 * overrides, and edit / delete (archive) / restore. Plain <table> with real controls: every control has
 * an accessible name that includes the job title; toggles are buttons with aria-pressed / role="switch".
 */
export interface JobTableProps {
    jobs: JobData[];
    busyId?: string | null;
    onPin: (job: JobData, pinned: boolean) => void;
    onBoardChange: (job: JobData, values: Partial<JobData>) => Promise<boolean>;
    onEdit: (job: JobData) => void;
    onDelete: (job: JobData) => void;
    onRestore: (job: JobData) => void;
}

const fill = (s: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), s);

type Tri = 'inherit' | 'on' | 'off';
const toTri = (v: boolean | null | undefined): Tri => (v === true ? 'on' : v === false ? 'off' : 'inherit');
const fromTri = (v: Tri): boolean | null => (v === 'on' ? true : v === 'off' ? false : null);

const Switch: React.FC<{ checked: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void; children?: React.ReactNode }> = ({ checked, label, disabled, onChange, children }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`jobs-admin-switch ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
    >
        <span className="jobs-admin-switch__track" aria-hidden="true"><span className="jobs-admin-switch__thumb" /></span>
        {children}
    </button>
);

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

const JobTable: React.FC<JobTableProps> = ({ jobs, busyId, onPin, onBoardChange, onEdit, onDelete, onRestore }) => {
    const tr = i18n.getTranslations();
    const t = tr.JobsAdmin;
    const statusLabels: Record<string, string> = {
        [JobStatus.ACTIVE]: tr.Jobs.Active,
        [JobStatus.SUSPENDED]: tr.Jobs.Suspended,
        [JobStatus.CLOSED]: tr.Jobs.Closed,
    };

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
                        <th scope="col">{t.ColPublic}</th>
                        <th scope="col">{t.ColSponsored}</th>
                        <th scope="col">{t.ColQuickApply}</th>
                        <th scope="col">{t.ColNoCv}</th>
                        <th scope="col">{t.ColActions}</th>
                    </tr>
                </thead>
                <tbody>
                    {jobs.map((job) => {
                        const id = job._id!;
                        const busy = busyId === id;
                        const archived = !!job.deletedAt;
                        const pinned = !!job.pinnedAt;
                        const isPublic = job.isPublic !== false;
                        const scheduled = isFutureDate(job.publishDate);
                        const title = job.title;
                        return (
                            <tr key={id} className={`${archived ? 'is-archived' : ''} ${pinned ? 'is-pinned' : ''}`} aria-busy={busy}>
                                <td>
                                    {!archived && (
                                        <div className="jobs-admin-pin">
                                            <button
                                                type="button"
                                                className={`board-pill board-pill--icon ${pinned ? 'board-pill--active' : ''}`}
                                                aria-pressed={pinned}
                                                aria-label={`${pinned ? t.PinAgain : t.Pin}: ${title}`}
                                                title={pinned ? t.PinAgain : t.Pin}
                                                disabled={busy}
                                                onClick={() => onPin(job, true)}
                                            >
                                                <i className={`bi ${pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'}`} aria-hidden="true" />
                                            </button>
                                            {pinned && (
                                                <button type="button" className="jobs-admin-link" disabled={busy}
                                                    aria-label={`${t.Unpin}: ${title}`} onClick={() => onPin(job, false)}>
                                                    {t.Unpin}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </td>
                                <th scope="row" className="jobs-admin-table__job">
                                    <span className="jobs-admin-table__title">{title}</span>
                                    <span className="jobs-admin-table__meta">
                                        {job.companyName}{job.location?.city ? ` · ${job.location.city}` : ''}{job.jobId ? ` · #${job.jobId}` : ''}
                                    </span>
                                    <span className="jobs-admin-badges">
                                        {pinned && <span className="jobs-admin-badge jobs-admin-badge--pin">{fill(t.PinnedSince, { date: formatDay(job.pinnedAt) })}</span>}
                                        {!isPublic && <span className="jobs-admin-badge" title={t.PrivateHint}>{t.Private}</span>}
                                        {scheduled && <span className="jobs-admin-badge jobs-admin-badge--scheduled" title={t.ScheduledHint}>{t.Scheduled}</span>}
                                        {archived && <span className="jobs-admin-badge jobs-admin-badge--archived">{fill(t.ArchivedBy, { date: formatDay(job.deletedAt) })}</span>}
                                    </span>
                                </th>
                                <td>
                                    <select
                                        className="form-select form-select-sm"
                                        aria-label={fill(t.StatusLabel, { title })}
                                        value={job.status}
                                        disabled={busy || archived}
                                        onChange={(e) => void onBoardChange(job, { status: e.target.value })}
                                    >
                                        {Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                    </select>
                                </td>
                                <td><PublishDateCell job={job} disabled={busy || archived} onSave={(v) => onBoardChange(job, v)} /></td>
                                <td>
                                    <Switch checked={isPublic} disabled={busy || archived}
                                        label={fill(t.PublicLabel, { title })}
                                        onChange={(v) => void onBoardChange(job, { isPublic: v })}>
                                        <span className="jobs-admin-switch__text">{isPublic ? t.On : t.Private}</span>
                                    </Switch>
                                </td>
                                <td>
                                    <Switch checked={!!job.isSponsored} disabled={busy || archived}
                                        label={fill(t.SponsoredLabel, { title })}
                                        onChange={(v) => void onBoardChange(job, { isSponsored: v })}>
                                        {job.isSponsored && <span className="jobs-admin-switch__crown" aria-hidden="true"><CrownIcon /></span>}
                                    </Switch>
                                </td>
                                {(['quickApplyOverride', 'quickApplyWithoutCvOverride'] as const).map((field) => {
                                    // While inheriting, the effective value IS the site default: show it.
                                    const eff = field === 'quickApplyOverride' ? job.applyPolicy?.quickApply : job.applyPolicy?.quickApplyWithoutCv;
                                    const inheritLabel = job[field] == null && eff !== undefined ? `${t.Inherit} (${eff ? t.On : t.Off})` : t.Inherit;
                                    return (
                                    <td key={field}>
                                        <select
                                            className="form-select form-select-sm"
                                            aria-label={fill(field === 'quickApplyOverride' ? t.QuickApplyLabel : t.NoCvLabel, { title })}
                                            value={toTri(job[field])}
                                            disabled={busy || archived}
                                            onChange={(e) => void onBoardChange(job, { [field]: fromTri(e.target.value as Tri) })}
                                        >
                                            <option value="inherit">{inheritLabel}</option>
                                            <option value="on">{t.On}</option>
                                            <option value="off">{t.Off}</option>
                                        </select>
                                    </td>
                                    );
                                })}
                                <td>
                                    <div className="jobs-admin-actions">
                                        {archived ? (
                                            <button type="button" className="board-pill board-pill--small" disabled={busy}
                                                aria-label={fill(t.RestoreLabel, { title })} onClick={() => onRestore(job)}>
                                                <i className="bi bi-arrow-counterclockwise" aria-hidden="true" /> {t.Restore}
                                            </button>
                                        ) : (
                                            <>
                                                <button type="button" className="board-pill board-pill--small" disabled={busy}
                                                    aria-label={fill(t.EditLabel, { title })} onClick={() => onEdit(job)}>
                                                    <i className="bi bi-pencil" aria-hidden="true" /> {t.Edit}
                                                </button>
                                                <a className="board-pill board-pill--small" href={`/job/${id}`} target="_blank" rel="noopener noreferrer"
                                                    aria-label={fill(t.ViewOnBoardLabel, { title })}>
                                                    <i className="bi bi-box-arrow-up-left" aria-hidden="true" /> {t.ViewOnBoard}
                                                </a>
                                                <button type="button" className="board-pill board-pill--small board-pill--danger" disabled={busy}
                                                    aria-label={fill(t.DeleteLabel, { title })} onClick={() => onDelete(job)}>
                                                    <i className="bi bi-trash" aria-hidden="true" /> {t.Delete}
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
