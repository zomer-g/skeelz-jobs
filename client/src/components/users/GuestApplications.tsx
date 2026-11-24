import React, { useState } from 'react';
import { Button, Table } from 'react-bootstrap';
import { i18n } from '../../i18n/I18n';
import { RequestEnum } from '../../i18n/General.enums';
import GlobalApiService from '../../services/api/GlobalApi.service';
import useToastStore from '../../store/Toast.store';
import { getDefaultFilenameByMime, isString } from '../../utils/utils';

type GuestApplication = {
    id: string; jobId: string; jobTitle: string; jobNumber: number | null; fullName: string; email: string; phoneNumber: string;
    hasCv: boolean; createdAt: string; salesforceSentAt: string | null; salesforceError: string | null;
    /** Set when the job belongs to an employer account (docs/employers.md "Applicants"). */
    employerForward: { employerJob: boolean; state: 'pending' | 'forwarded' | 'seen'; forwardId: string | null; forwardable: boolean } | null;
};
type ListAnswer = { data: { applications: GuestApplication[]; total: number; cut: number; page: number; limit: number; salesforceEnabled: boolean; unsent: number } };

const LIMIT = 20;

/**
 * Quick (guest) applications for content managers and admins (GET /api/admin/guest-applications). Loaded only when
 * asked: every page shown is logged and counted in the daily limit on the server (peopleHandover), every CV opened
 * too (cvHandover). Nothing here changes or deletes an application.
 */
/** readOnly: a placement coordinator (no Salesforce push). */
const GuestApplications: React.FC<{ readOnly?: boolean }> = ({ readOnly = false }) => {
    const t = i18n.getTranslations().GuestApplications;
    const { showToast } = useToastStore();
    const [page, setPage] = useState(1);
    const [answer, setAnswer] = useState<ListAnswer['data'] | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async (p: number) => {
        setBusy(true);
        const r = await GlobalApiService.generalRequest<ListAnswer>(RequestEnum.Get, 'admin/guest-applications', { page: p, limit: LIMIT });
        setBusy(false);
        if (isString(r)) { showToast(r, 'error'); return; }
        setAnswer(r.data);
        setPage(p);
    };

    const downloadCv = async (id: string) => {
        const r: any = await GlobalApiService.generalRequest(RequestEnum.Get, `admin/guest-applications/${id}/cv`, {}, {},
            { responseType: 'blob', returnWholeResponse: true });
        if (isString(r)) { showToast(r, 'error'); return; }
        const type = r.headers['content-type'] || 'application/octet-stream';
        const match = String(r.headers['content-disposition'] || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/);
        const url = window.URL.createObjectURL(new Blob([r.data], { type }));
        const a = document.createElement('a');
        a.href = url;
        a.download = match?.[1] ? decodeURIComponent(match[1]) : getDefaultFilenameByMime(type);
        a.click();
        setTimeout(() => window.URL.revokeObjectURL(url), 10000);
    };

    const push = async () => {
        setBusy(true);
        const r: any = await GlobalApiService.generalRequest(RequestEnum.Post, 'admin/guest-applications/salesforce-push', { limit: 20 });
        setBusy(false);
        if (isString(r)) { showToast(r, 'error'); return; }
        showToast(`${t.Pushed}: ${r.data.pushed}. ${t.Failed}: ${r.data.failed}.`, r.data.failed ? 'warning' : 'success');
        void load(page);
    };

    const te = i18n.getTranslations().EmployerApplicants;
    const forwardAct = async (path: string, body: object, confirmText: string, done: string) => {
        if (!window.confirm(confirmText)) return;
        setBusy(true);
        const r: any = await GlobalApiService.generalRequest(RequestEnum.Post, path, body);
        setBusy(false);
        if (isString(r)) { showToast(r, 'error'); return; }
        showToast(done, 'success');
        void load(page);
    };
    const forwardCell = (a: GuestApplication) => {
        const f = a.employerForward;
        if (!f) return '—';
        return (
            <>
                {f.state === 'seen' ? te.StateSeen : f.state === 'forwarded' ? te.StateForwarded : te.StatePending}{' '}
                {f.forwardable && <Button size="sm" variant="dark" disabled={busy} aria-label={`${te.Forward}: ${a.fullName}`}
                    onClick={() => forwardAct('admin/employer-forwards', { kind: 'guest', applicationId: a.id }, te.ConfirmForward, te.Forwarded)}>{te.Forward}</Button>}
                {f.state === 'forwarded' && f.forwardId && <Button size="sm" variant="outline-danger" disabled={busy} aria-label={`${te.CancelForward}: ${a.fullName}`}
                    onClick={() => forwardAct(`admin/employer-forwards/${f.forwardId}/cancel`, {}, te.ConfirmCancel, te.Cancelled)}>{te.CancelForward}</Button>}
            </>
        );
    };

    const pages = answer ? Math.max(1, Math.ceil(answer.total / LIMIT)) : 1;
    const day = (s: string) => new Date(s).toLocaleDateString('he-IL');

    return (
        <section className="pt-5" aria-labelledby="guest-apps-title">
            <h2 id="guest-apps-title" className="font-RubikBold fs-4">{t.Title}</h2>
            <p className="font-RubikRegular text-color-dark-grey">{t.Intro}</p>
            {!answer ? (
                <Button className="rounded-pill" variant="dark" disabled={busy} onClick={() => load(1)}>{t.Show}</Button>
            ) : (
                <>
                    <div className="d-flex flex-wrap gap-3 align-items-center mb-3">
                        <span className="font-RubikRegular">{t.UnsentCount} {answer.unsent}</span>
                        {!readOnly && answer.salesforceEnabled && answer.unsent > 0 &&
                            <Button size="sm" variant="dark" className="rounded-pill" disabled={busy} onClick={push}>{t.Push}</Button>}
                    </div>
                    {answer.cut > 0 && <p role="alert" className="text-danger">{t.Cut}</p>}
                    {answer.applications.length === 0 ? <p>{t.None}</p> : (
                        <div className="table-responsive">
                            <Table striped bordered size="sm">
                                <thead>
                                    <tr>
                                        <th scope="col">{t.Date}</th><th scope="col">{t.Job}</th><th scope="col">{t.Name}</th>
                                        <th scope="col">{t.Email}</th><th scope="col">{t.Phone}</th><th scope="col">{t.Cv}</th>
                                        <th scope="col">{t.Salesforce}</th><th scope="col">{te.Employer}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {answer.applications.map((a) => (
                                        <tr key={a.id}>
                                            <td>{day(a.createdAt)}</td>
                                            <td>{a.jobNumber ? `${a.jobNumber} · ` : ''}{a.jobTitle}</td>
                                            <td>{a.fullName}</td>
                                            <td dir="ltr">{a.email}</td>
                                            <td dir="ltr">{a.phoneNumber}</td>
                                            <td>{a.hasCv ? <Button size="sm" variant="outline-dark" onClick={() => downloadCv(a.id)}>{t.Download}</Button> : t.NoCv}</td>
                                            <td>{a.salesforceSentAt ? `${t.Sent} ${day(a.salesforceSentAt)}` : t.NotSent}</td>
                                            <td>{forwardCell(a)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </Table>
                        </div>
                    )}
                    <div className="d-flex gap-2 align-items-center">
                        <Button size="sm" variant="outline-dark" disabled={busy || page <= 1} onClick={() => load(page - 1)}>{t.Prev}</Button>
                        <span>{page} / {pages}</span>
                        <Button size="sm" variant="outline-dark" disabled={busy || page >= pages} onClick={() => load(page + 1)}>{t.Next}</Button>
                    </div>
                </>
            )}
        </section>
    );
};

export default GuestApplications;
