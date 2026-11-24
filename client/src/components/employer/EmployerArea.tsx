// The employer's area (/employer; client guard [EMPLOYER], server gate employerOnly). docs/employers.md.
// Own details, own submissions, own published jobs, edit requests (pending until a content manager approves; the
// job on the board doesn't change before that). Jobs imported from the existing site are shown read-only.
// "מועמדים למשרות שלי" (EmployerApplicants): only the applicants the SKEELZ team forwarded — name + CV.
import { getPublicJobFields, valuesToSend } from '../../utils/customFields';
import React, { useEffect, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import useAuthStore from '../../store/Auth.store';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { isCandidateUser } from '../../i18n/General.enums';
import SubmissionFields, { EMPTY_VALUES, ErrorSummary, Errors, SubmissionValues, validate } from './SubmissionFields';
import { DetailsFields, EmployerDetails, checkDetails } from './EmployerSignUp';
import { ApiError, EditableValues, api, fmtDate } from './employerApi';
import EmployerApplicants from './EmployerApplicants';

type Me = { id: string; email: string; firstName: string; lastName: string; companyName: string; phone: string; jobTitle: string | null; claimable: number };
type Submission = { id: string; status: 'pending' | 'approved' | 'rejected'; title: string; companyName: string; city: string | null; createdAt: string; reviewedAt: string | null; rejectReason: string | null; jobId: string | null };
type Job = { id: string; jobId: number; title: string; companyName: string; status: string; publishDate: string; archived: boolean; readOnly: boolean; pendingRequestId: string | null };
type Request = { id: string; jobId: string; jobTitle: string | null; status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; changes: Record<string, unknown>; createdAt: string; reviewedAt: string | null; rejectReason: string | null };

const toForm = (v: EditableValues): SubmissionValues => ({
  ...EMPTY_VALUES, title: v.title, companyName: v.companyName, citySymbol: String(v.citySymbol), jobScope: v.jobScope,
  requiredSkills: v.requiredSkills, description: v.description, externalLink: v.externalLink ?? '', publicEmail: v.publicEmail ?? '',
  thresholdCondition: v.thresholdCondition ?? '',
  customFields: { ...((v as any).customFields ?? {}) },
});
const fromForm = (v: SubmissionValues) => ({
  title: v.title, companyName: v.companyName, citySymbol: Number(v.citySymbol), jobScope: v.jobScope, requiredSkills: v.requiredSkills,
  description: v.description, externalLink: v.externalLink.trim(), publicEmail: v.publicEmail.trim(),
  thresholdCondition: (v.thresholdCondition ?? '').trim(),
  // The added job fields: every one ('' / false = no answer); the server keeps only the ones that changed.
  ...(getPublicJobFields(true).length ? { customFields: valuesToSend(getPublicJobFields(true), v.customFields) } : {}),
});

const Badge: React.FC<{ kind: 'ok' | 'wait' | 'no' | 'muted'; children: React.ReactNode }> = ({ kind, children }) => (
  <span className={`badge rounded-pill ${kind === 'ok' ? 'text-bg-success' : kind === 'wait' ? 'text-bg-warning' : kind === 'no' ? 'text-bg-danger' : 'text-bg-secondary'}`}>{children}</span>
);

const EmployerArea: React.FC = () => {
  useLanguageStore();
  const t = i18n.getTranslations().Employers;
  const tf = i18n.getTranslations().EmployerForm;
  const [me, setMe] = useState<Me | null>(null);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editingMe, setEditingMe] = useState<EmployerDetails | null>(null);
  const [meBad, setMeBad] = useState<Partial<Record<keyof EmployerDetails, string>>>({});
  const [editing, setEditing] = useState<{ job: Job; values: SubmissionValues; original: SubmissionValues } | null>(null);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const editRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { document.title = `${t.AreaTitle} | SKEELZ`; }, [t.AreaTitle]);

  const load = async () => {
    setLoading(true);
    try {
      const [m, s, j, r] = await Promise.all([
        api<Me>('/employer/me'), api<{ items: Submission[] }>('/employer/submissions'),
        api<{ items: Job[] }>('/employer/jobs'), api<{ items: Request[] }>('/employer/edit-requests'),
      ]);
      setMe(m); setSubs(s.items); setJobs(j.items); setRequests(r.items);
    } catch (e) {
      if ((e as ApiError).status === 401 || (e as ApiError).status === 403) { useAuthStore.getState().logOut(); window.location.assign('/'); return; }
      setMessage({ kind: 'error', text: t.LoadError });
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing?.job.id]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (e) {
      const err = e as ApiError;
      if (err.fields && !Array.isArray(err.fields)) setErrors(err.fields as Errors);
      setMessage({ kind: 'error', text: err.code === 'no_changes' ? t.NoChanges : err.message });
    } finally { setBusy(false); }
  };

  const saveMe = () => act(async () => {
    if (!editingMe) return;
    const b = checkDetails(editingMe);
    setMeBad(b);
    if (Object.keys(b).length) return;
    const updated = await api<Me>('/employer/me', { method: 'PATCH', body: JSON.stringify({ ...editingMe, jobTitle: editingMe.jobTitle.trim() }) });
    setMe({ ...updated, claimable: me?.claimable ?? 0 }); setEditingMe(null);
    const u = useAuthStore.getState().user;
    if (u) useAuthStore.getState().setUser({ ...u, firstName: updated.firstName, lastName: updated.lastName } as any);
    setMessage({ kind: 'ok', text: t.Saved });
  });

  const claim = () => act(async () => {
    await api('/employer/submissions/claim', { method: 'POST', body: '{}' });
    setMessage({ kind: 'ok', text: t.Claimed });
    await load();
  });

  const openEdit = (job: Job) => act(async () => {
    const d = await api<{ values: EditableValues; readOnly: boolean }>(`/employer/jobs/${job.id}`);
    const v = toForm(d.values);
    setEditing({ job, values: v, original: v }); setErrors({}); setNote('');
  });

  const sendEdit = () => act(async () => {
    if (!editing) return;
    const e = validate(editing.values, { contact: false, onlyJobPageExtra: true });
    setErrors(e);
    if (Object.keys(e).length) return;
    const now = fromForm(editing.values), before = fromForm(editing.original);
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(now) as (keyof typeof now)[]) {
      if (JSON.stringify(now[k]) !== JSON.stringify(before[k])) changed[k] = now[k];
    }
    if (!Object.keys(changed).length) { setMessage({ kind: 'error', text: t.NoChanges }); return; }
    await api(`/employer/jobs/${editing.job.id}/edit-requests`, { method: 'POST', body: JSON.stringify({ ...changed, ...(note.trim() ? { note } : {}) }) });
    setEditing(null);
    setMessage({ kind: 'ok', text: t.RequestSent });
    await load();
  });

  const withdraw = (id: string) => act(async () => {
    await api(`/employer/edit-requests/${id}/withdraw`, { method: 'POST', body: '{}' });
    setMessage({ kind: 'ok', text: t.Withdrawn });
    await load();
  });

  const subStatus = (s: Submission['status']) =>
    s === 'pending' ? <Badge kind="wait">{t.StatusPending}</Badge> : s === 'approved' ? <Badge kind="ok">{t.StatusApproved}</Badge> : <Badge kind="no">{t.StatusRejected}</Badge>;
  const reqStatus = (s: Request['status']) =>
    s === 'pending' ? <Badge kind="wait">{t.StatusPending}</Badge> : s === 'approved' ? <Badge kind="ok">{t.StatusApproved}</Badge>
      : s === 'rejected' ? <Badge kind="no">{t.StatusRejected}</Badge> : <Badge kind="muted">{t.StatusWithdrawn}</Badge>;
  const jobStatus = (j: Job) => j.archived ? <Badge kind="muted">{t.JobArchived}</Badge>
    : j.status === 'Active' ? <Badge kind="ok">{t.JobActive}</Badge> : j.status === 'Suspended' ? <Badge kind="wait">{t.JobSuspended}</Badge> : <Badge kind="muted">{t.JobClosed}</Badge>;
  const fieldLabel = (k: string) => (({ title: tf.JobTitle, companyName: tf.CompanyName, citySymbol: tf.City, jobScope: tf.JobScope,
    requiredSkills: tf.Skills, description: tf.Description, externalLink: tf.ExternalLink, publicEmail: tf.PublicEmail,
    thresholdCondition: i18n.getTranslations().Threshold.Label, customFields: tf.ExtraSection } as Record<string, string>)[k]
    ?? (k.startsWith('customFields.') ? getPublicJobFields().find((f) => `customFields.${f.id}` === k)?.label ?? tf.ExtraSection : k));

  const card = 'border rounded-4 p-3 p-md-4 mb-4 bg-white';
  const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #e5e5e5', textAlign: 'start', verticalAlign: 'top' };

  return (
    <div dir={i18n.isRTL() ? 'rtl' : 'ltr'} className="container py-4" style={{ maxWidth: 1000, lineHeight: 1.6 }}>
      <div className="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">
        <h1 className="font-EzerRegularLoft display-6 m-0">{t.AreaTitle}</h1>
        <a href={ClientRoutes.PostJob} className="btn bg-color-purple text-white rounded-pill px-4"><i className="bi bi-plus-lg ms-1 me-1" aria-hidden="true" />{t.PostJob}</a>
      </div>
      <p className="text-muted">{t.AreaIntro}</p>
      {/* Several roles per account (23.11.2026): the same account can be a candidate too. */}
      {!isCandidateUser(useAuthStore.getState().user) && (
        <p className="small"><a href={ClientRoutes.JoinAsCandidate}>הצטרפות גם כמועמד/ת (באותו חשבון)</a></p>
      )}

      <div aria-live="polite">{message && <div className={`alert ${message.kind === 'ok' ? 'alert-success' : 'alert-danger'}`}>{message.text}</div>}</div>

      {loading && !me ? <p>{t.Loading}</p> : me && (
        <>
          {me.claimable > 0 && (
            <section className="alert alert-info d-flex justify-content-between align-items-center flex-wrap gap-2" aria-labelledby="claim-title">
              <div>
                <h2 id="claim-title" className="fs-6 font-RubikBold mb-1">{t.ClaimTitle} ({me.claimable})</h2>
                <p className="mb-0 small">{t.ClaimText}</p>
              </div>
              <button type="button" className="btn btn-dark rounded-pill px-4" disabled={busy} onClick={claim}>{t.ClaimButton}</button>
            </section>
          )}

          {editing && (
            <section className={card} aria-labelledby="edit-title">
              <h2 id="edit-title" ref={editRef} tabIndex={-1} className="fs-4 font-RubikBold">{t.EditTitle}: {editing.job.title}</h2>
              <p className="small">{t.EditIntro}</p>
              <form noValidate onSubmit={(e) => { e.preventDefault(); void sendEdit(); }}>
                <ErrorSummary errors={errors} prefix="emp-edit" />
                <SubmissionFields prefix="emp-edit" values={editing.values} errors={errors} disabled={busy} showContact={false} onlyJobPageExtra
                  onChange={(p) => setEditing({ ...editing, values: { ...editing.values, ...p } })} />
                <div className="mb-3">
                  <label htmlFor="emp-edit-note" className="form-label">{t.Note}</label>
                  <textarea id="emp-edit-note" className="form-control" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
                </div>
                <div className="d-flex gap-2 flex-wrap">
                  <button type="submit" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy}>{t.SendRequest}</button>
                  <button type="button" className="btn btn-outline-dark rounded-pill px-4" disabled={busy} onClick={() => setEditing(null)}>{t.Cancel}</button>
                </div>
              </form>
            </section>
          )}

          <section className={card} aria-labelledby="my-jobs">
            <h2 id="my-jobs" className="fs-5 font-RubikBold">{t.MyJobs}</h2>
            {jobs.length === 0 ? <p className="mb-0">{t.NoJobs}</p> : (
              <div className="table-responsive">
                <table className="w-100" style={{ borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead><tr><th style={cell}>{tf.JobTitle}</th><th style={cell}>{t.Status}</th><th style={cell}>{t.Published}</th><th style={cell}><span className="visually-hidden">{t.EditJob}</span></th></tr></thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id}>
                        <td style={cell}>{j.title}<div className="small text-muted">{j.companyName}</div></td>
                        <td style={cell}>{jobStatus(j)}</td>
                        <td style={cell}>{fmtDate(j.publishDate)}</td>
                        <td style={cell}>
                          <div className="d-flex gap-2 flex-wrap">
                            {!j.archived && j.status === 'Active' && <a className="btn btn-sm btn-outline-dark" href={`/job/${j.id}`} target="_blank" rel="noopener noreferrer">{t.ViewJob}</a>}
                            {j.readOnly ? (
                              <span className="small text-muted" title={t.ReadOnlyHint}><i className="bi bi-lock ms-1 me-1" aria-hidden="true" />{t.ReadOnly}<span className="visually-hidden">: {t.ReadOnlyHint}</span></span>
                            ) : j.pendingRequestId ? (
                              <span className="small">{t.EditPending}</span>
                            ) : !j.archived && (
                              <button type="button" className="btn btn-sm bg-color-purple text-white" disabled={busy} onClick={() => openEdit(j)}
                                aria-label={`${t.EditJob}: ${j.title}`}>{t.EditJob}</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <EmployerApplicants card={card} />

          <section className={card} aria-labelledby="my-requests">
            <h2 id="my-requests" className="fs-5 font-RubikBold">{t.MyRequests}</h2>
            {requests.length === 0 ? <p className="mb-0">{t.NoRequests}</p> : (
              <ul className="list-unstyled mb-0">
                {requests.map((r) => (
                  <li key={r.id} className="border-bottom py-2 d-flex justify-content-between flex-wrap gap-2">
                    <div>
                      <div className="font-RubikMedium">{r.jobTitle ?? r.jobId} {reqStatus(r.status)}</div>
                      <div className="small text-muted">{t.Fields}: {Object.keys(r.changes).map(fieldLabel).join(', ')} · {t.Sent} {fmtDate(r.createdAt)}</div>
                      {r.status === 'rejected' && r.rejectReason && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.Reason}: {r.rejectReason}</div>}
                    </div>
                    {r.status === 'pending' && <button type="button" className="btn btn-sm btn-outline-danger align-self-start" disabled={busy} onClick={() => withdraw(r.id)}>{t.Withdraw}</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={card} aria-labelledby="my-subs">
            <h2 id="my-subs" className="fs-5 font-RubikBold">{t.MySubmissions}</h2>
            {subs.length === 0 ? <p className="mb-0">{t.NoSubmissions}</p> : (
              <ul className="list-unstyled mb-0">
                {subs.map((s) => (
                  <li key={s.id} className="border-bottom py-2">
                    <div className="font-RubikMedium">{s.title} <span className="text-muted small">· {s.companyName}{s.city ? ` · ${s.city}` : ''}</span> {subStatus(s.status)}</div>
                    <div className="small text-muted">{t.Sent} {fmtDate(s.createdAt)}{s.reviewedAt ? ` · ${fmtDate(s.reviewedAt)}` : ''}</div>
                    {s.status === 'rejected' && s.rejectReason && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.Reason}: {s.rejectReason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={card} aria-labelledby="my-details">
            <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
              <h2 id="my-details" className="fs-5 font-RubikBold m-0">{t.MyDetails}</h2>
              {!editingMe && <button type="button" className="btn btn-sm btn-outline-dark rounded-pill px-3" onClick={() => { setEditingMe({ firstName: me.firstName, lastName: me.lastName, companyName: me.companyName, phone: me.phone, jobTitle: me.jobTitle ?? '' }); setMeBad({}); }}>{t.EditDetails}</button>}
            </div>
            {editingMe ? (
              <form noValidate className="mt-3" onSubmit={(e) => { e.preventDefault(); void saveMe(); }}>
                <DetailsFields prefix="emp-me" values={editingMe} bad={meBad} disabled={busy} email={me.email}
                  emailHint={i18n.getTranslations().Profile.EmailReadOnly} onChange={(p) => setEditingMe({ ...editingMe, ...p })} />
                <div className="d-flex gap-2">
                  <button type="submit" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy}>{t.Save}</button>
                  <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => setEditingMe(null)}>{t.Cancel}</button>
                </div>
              </form>
            ) : (
              <dl className="row mb-0 mt-3">
                <dt className="col-sm-3">{t.FirstName}</dt><dd className="col-sm-9">{me.firstName} {me.lastName}</dd>
                <dt className="col-sm-3">{t.Company}</dt><dd className="col-sm-9">{me.companyName}</dd>
                <dt className="col-sm-3">{t.Email}</dt><dd className="col-sm-9" dir="ltr" style={{ textAlign: 'start' }}>{me.email}</dd>
                <dt className="col-sm-3">{t.Phone}</dt><dd className="col-sm-9" dir="ltr" style={{ textAlign: 'start' }}>{me.phone}</dd>
                {me.jobTitle && <><dt className="col-sm-3">{t.JobTitle}</dt><dd className="col-sm-9">{me.jobTitle}</dd></>}
              </dl>
            )}
          </section>
        </>
      )}
    </div>
  );
};

export default EmployerArea;
