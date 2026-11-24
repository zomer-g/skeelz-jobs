import React, { useState } from 'react';
import { Button, ButtonGroup, Table } from 'react-bootstrap';
import { i18n } from '../../i18n/I18n';
import { RequestEnum } from '../../i18n/General.enums';
import GlobalApiService from '../../services/api/GlobalApi.service';
import useToastStore from '../../store/Toast.store';
import { isString } from '../../utils/utils';

type Row = {
    kind: 'application' | 'guest'; applicationId: string; name: string; appliedAt: string; hasCv: boolean;
    jobId: string; jobNumber: number; jobTitle: string; jobActive: boolean; accessOpen: boolean;
    employer: { id: string; companyName: string; name: string; active: boolean };
    state: 'pending' | 'forwarded' | 'seen'; forward: { id: string; at: string; seenAt: string | null } | null; forwardable: boolean;
};
type Answer = { data: { items: Row[]; total: number; cut: number; page: number; limit: number; state: string; pending: number } };
type Filter = 'pending' | 'forwarded' | 'all';
const LIMIT = 50;

/**
 * Applications (registered + quick) to jobs owned by an employer account, for content managers and admins
 * (GET /api/admin/employer-forwards; docs/employers.md "Applicants"). Grouped by employer and job. "העברה למעסיק"
 * makes ONE application visible to that employer (name + CV); "ביטול העברה" works only before the employer saw it.
 * Loaded only when asked: every page is logged and counted in the daily limit (peopleHandover).
 */
/** readOnly: a placement coordinator sees the list but forwards / cancels nothing (content managers do). */
const EmployerForwards: React.FC<{ readOnly?: boolean }> = ({ readOnly = false }) => {
    const t = i18n.getTranslations().EmployerApplicants;
    const { showToast } = useToastStore();
    const [filter, setFilter] = useState<Filter>('pending');
    const [page, setPage] = useState(1);
    const [answer, setAnswer] = useState<Answer['data'] | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async (p: number, f: Filter = filter) => {
        setBusy(true);
        const r = await GlobalApiService.generalRequest<Answer>(RequestEnum.Get, 'admin/employer-forwards', { state: f, page: p, limit: LIMIT });
        setBusy(false);
        if (isString(r)) { showToast(r, 'error'); return; }
        setAnswer(r.data); setPage(p); setFilter(f);
    };

    const act = async (path: string, body: object, confirmText: string, done: string) => {
        if (!window.confirm(confirmText)) return;
        setBusy(true);
        const r: any = await GlobalApiService.generalRequest(RequestEnum.Post, path, body);
        setBusy(false);
        if (isString(r)) { showToast(r, 'error'); return; }
        showToast(done, 'success');
        void load(page);
    };
    const forward = (row: Row) => act('admin/employer-forwards', { kind: row.kind, applicationId: row.applicationId }, t.ConfirmForward, t.Forwarded);
    const cancel = (row: Row) => row.forward && act(`admin/employer-forwards/${row.forward.id}/cancel`, {}, t.ConfirmCancel, t.Cancelled);

    const day = (s: string) => new Date(s).toLocaleDateString('he-IL');
    const pages = answer ? Math.max(1, Math.ceil(answer.total / LIMIT)) : 1;
    // Group by employer, then job (the server already orders the rows that way).
    const groups: { key: string; employer: Row['employer']; jobs: { key: string; row: Row; rows: Row[] }[] }[] = [];
    for (const r of answer?.items ?? []) {
        let g = groups.find((x) => x.key === r.employer.id);
        if (!g) { g = { key: r.employer.id, employer: r.employer, jobs: [] }; groups.push(g); }
        let j = g.jobs.find((x) => x.key === r.jobId);
        if (!j) { j = { key: r.jobId, row: r, rows: [] }; g.jobs.push(j); }
        j.rows.push(r);
    }
    const stateText = (r: Row) => r.state === 'seen' ? t.StateSeen : r.state === 'forwarded' ? t.StateForwarded : t.StatePending;

    return (
        <section className="pt-5" aria-labelledby="emp-fwd-title">
            <h2 id="emp-fwd-title" className="font-RubikBold fs-4">{t.StaffTitle}</h2>
            <p className="font-RubikRegular text-color-dark-grey">{t.StaffIntro}</p>
            {!answer ? (
                <Button className="rounded-pill" variant="dark" disabled={busy} onClick={() => load(1, 'pending')}>{t.StaffShow}</Button>
            ) : (
                <>
                    <div className="d-flex flex-wrap gap-3 align-items-center mb-3">
                        <ButtonGroup aria-label={t.State}>
                            {(['pending', 'forwarded', 'all'] as Filter[]).map((f) => (
                                <Button key={f} size="sm" variant={filter === f ? 'dark' : 'outline-dark'} aria-pressed={filter === f}
                                    disabled={busy} onClick={() => load(1, f)}>
                                    {f === 'pending' ? t.FilterPending : f === 'forwarded' ? t.FilterForwarded : t.FilterAll}
                                </Button>
                            ))}
                        </ButtonGroup>
                        <span className="font-RubikRegular">{t.PendingCount} {answer.pending}</span>
                    </div>
                    {answer.cut > 0 && <p role="alert" className="text-danger">{i18n.getTranslations().GuestApplications.Cut}</p>}
                    {groups.length === 0 ? <p>{t.NoneStaff}</p> : groups.map((g) => (
                        <div key={g.key} className="mb-4">
                            <h3 className="fs-5 font-RubikMedium">
                                {t.Employer}: {g.employer.companyName || '—'} <span className="text-muted fs-6">({g.employer.name})</span>
                                {!g.employer.active && <span className="badge text-bg-secondary ms-2 me-2">{t.EmployerInactive}</span>}
                            </h3>
                            {g.jobs.map((j) => (
                                <div key={j.key} className="mb-3">
                                    <h4 className="fs-6 font-RubikBold">
                                        {t.Job}: {j.row.jobNumber} · {j.row.jobTitle}
                                        {!j.row.accessOpen && <span className="badge text-bg-secondary ms-2 me-2">{t.WindowClosed}</span>}
                                    </h4>
                                    <div className="table-responsive">
                                        <Table striped bordered size="sm">
                                            <thead>
                                                <tr>
                                                    <th scope="col">{t.Name}</th><th scope="col">{t.Kind}</th><th scope="col">{t.Applied}</th>
                                                    <th scope="col">{t.State}</th><th scope="col"><span className="visually-hidden">{t.Forward}</span></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {j.rows.map((r) => (
                                                    <tr key={`${r.kind}:${r.applicationId}`}>
                                                        <td>{r.name}</td>
                                                        <td>{r.kind === 'guest' ? t.KindGuest : t.KindRegistered}</td>
                                                        <td>{day(r.appliedAt)}</td>
                                                        <td>{stateText(r)}{r.forward ? ` · ${day(r.forward.at)}` : ''}</td>
                                                        <td>
                                                            {!readOnly && r.forwardable && (
                                                                <Button size="sm" variant="dark" disabled={busy} onClick={() => forward(r)}
                                                                    aria-label={`${t.Forward}: ${r.name}`}>{t.Forward}</Button>
                                                            )}
                                                            {!readOnly && r.state === 'forwarded' && (
                                                                <Button size="sm" variant="outline-danger" disabled={busy} onClick={() => cancel(r)}
                                                                    aria-label={`${t.CancelForward}: ${r.name}`}>{t.CancelForward}</Button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </Table>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ))}
                    <div className="d-flex gap-2 align-items-center">
                        <Button size="sm" variant="outline-dark" disabled={busy || page <= 1} onClick={() => load(page - 1)}>{i18n.getTranslations().GuestApplications.Prev}</Button>
                        <span>{page} / {pages}</span>
                        <Button size="sm" variant="outline-dark" disabled={busy || page >= pages} onClick={() => load(page + 1)}>{i18n.getTranslations().GuestApplications.Next}</Button>
                    </div>
                </>
            )}
        </section>
    );
};

export default EmployerForwards;
