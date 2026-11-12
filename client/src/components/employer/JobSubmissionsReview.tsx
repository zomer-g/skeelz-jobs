// Staff screen /jobs-management/submissions: jobs sent by employers (/post-job).
// List (no contact details) → open one (logged) → edit / approve (publishes) / reject.
// Server: /api/admin/job-submissions (contentGate in server/src/routes.ts). Every action is logged.
import React, { useEffect, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import { getLocalizedDictionary } from '../../i18n/i18nHelper';
import { LocalizedDataKey } from '../../i18n/General.enums';
import SubmissionFields, { ErrorSummary, Errors, SubmissionValues, validate } from './SubmissionFields';

type Status = 'pending' | 'approved' | 'rejected';
type Summary = {
  id: string; status: Status; title: string; companyName: string; citySymbol: number; city: string | null;
  createdAt: string; reviewedAt: string | null; reviewedBy: string | null; jobId: string | null;
};
type Full = Summary & {
  jobScope: string[]; requiredSkills: string[]; requiredSkillsDetails: Record<string, string>; description: string;
  externalLink: string | null; publicEmail: string | null; contactName: string; contactEmail: string; contactPhone: string;
  consentAt: string; rejectReason: string | null;
};

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { fields: body.fields });
  return body.data;
};

const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('he-IL') : '—');
const toValues = (s: Full): SubmissionValues => ({
  title: s.title, companyName: s.companyName, citySymbol: String(s.citySymbol), jobScope: s.jobScope, requiredSkills: s.requiredSkills,
  description: s.description, externalLink: s.externalLink ?? '', publicEmail: s.publicEmail ?? '', contactName: s.contactName,
  contactEmail: s.contactEmail, contactPhone: s.contactPhone,
});

const JobSubmissionsReview: React.FC = () => {
  const { currentLanguage } = useLanguageStore();
  const t = i18n.getTranslations().EmployerForm;
  const scopeLabels = getLocalizedDictionary(LocalizedDataKey.JOB_SCOPE, currentLanguage);
  const [status, setStatus] = useState<Status>('pending');
  const [items, setItems] = useState<Summary[]>([]);
  const [counts, setCounts] = useState<Record<Status, number>>({ pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Full | null>(null);
  const [editing, setEditing] = useState<SubmissionValues | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);

  const load = async (s: Status = status) => {
    setLoading(true);
    try {
      const d = await api(`/admin/job-submissions?status=${s}`);
      setItems(d.items); setCounts(d.counts);
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(status); }, [status]);
  useEffect(() => { if (open) detailRef.current?.focus(); }, [open?.id]);

  const openOne = async (id: string) => {
    setMessage(null); setEditing(null); setRejecting(false); setReason(''); setErrors({});
    try { setOpen(await api(`/admin/job-submissions/${id}`)); }
    catch (e) { setMessage({ kind: 'error', text: (e as Error).message }); }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (e) {
      const fields = (e as any).fields;
      if (fields) setErrors(fields);
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally { setBusy(false); }
  };

  const save = () => act(async () => {
    if (!open || !editing) return;
    const e = validate(editing);
    setErrors(e);
    if (Object.keys(e).length) return;
    const updated = await api(`/admin/job-submissions/${open.id}`, {
      method: 'PATCH', body: JSON.stringify({ ...editing, citySymbol: Number(editing.citySymbol) }),
    });
    setOpen(updated); setEditing(null);
    setMessage({ kind: 'ok', text: t.SavedToast });
    load();
  });

  const approve = () => act(async () => {
    if (!open || !window.confirm(t.ConfirmApprove)) return;
    await api(`/admin/job-submissions/${open.id}/approve`, { method: 'POST', body: '{}' });
    setOpen(null);
    setMessage({ kind: 'ok', text: t.ApprovedToast });
    load();
  });

  const reject = () => act(async () => {
    if (!open) return;
    await api(`/admin/job-submissions/${open.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    setOpen(null); setRejecting(false); setReason('');
    setMessage({ kind: 'ok', text: t.RejectedToast });
    load();
  });

  const tabs: [Status, string][] = [['pending', t.Pending], ['approved', t.Approved], ['rejected', t.Rejected]];
  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #ddd', textAlign: 'start', verticalAlign: 'top' };

  return (
    <div dir={i18n.isRTL() ? 'rtl' : 'ltr'} className="p-4">
      <h1 className="pt-3 pb-3 font-EzerRegularLoft display-6">{t.ReviewTitle}</h1>

      <div role="tablist" aria-label={t.ReviewTitle} className="d-flex gap-2 mb-3">
        {tabs.map(([s, label]) => (
          <button key={s} type="button" role="tab" aria-selected={status === s}
            className={`btn rounded-pill ${status === s ? 'bg-color-purple text-white' : 'btn-outline-dark'}`}
            onClick={() => { setOpen(null); setStatus(s); }}>
            {label} ({counts[s]})
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {message && <div className={`alert ${message.kind === 'ok' ? 'alert-success' : 'alert-danger'}`}>{message.text}</div>}
      </div>

      {loading ? <p>{t.Loading}</p> : items.length === 0 ? <p>{t.NoItems}</p> : (
        <table className="w-100 mb-4" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={cell}>{t.JobTitle}</th><th style={cell}>{t.CompanyName}</th><th style={cell}>{t.City}</th>
              <th style={cell}>{t.Sent}</th>{status !== 'pending' && <th style={cell}>{t.Reviewed}</th>}<th style={cell}><span className="visually-hidden">{t.Open}</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} style={open?.id === s.id ? { background: '#f3f0ff' } : undefined}>
                <td style={cell}>{s.title}</td><td style={cell}>{s.companyName}</td><td style={cell}>{s.city ?? s.citySymbol}</td>
                <td style={cell}>{fmt(s.createdAt)}</td>
                {status !== 'pending' && <td style={cell}>{fmt(s.reviewedAt)} {s.reviewedBy ? `${t.By} ${s.reviewedBy}` : ''}</td>}
                <td style={cell}>
                  <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => openOne(s.id)}
                    aria-label={`${t.Open}: ${s.title} — ${s.companyName}`}>{t.Open}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <section aria-labelledby="submission-detail-title" className="border rounded p-3" style={{ maxWidth: 960 }}>
          <div className="d-flex justify-content-between align-items-start gap-2">
            <h2 id="submission-detail-title" ref={detailRef} tabIndex={-1} className="fs-4 font-RubikBold">{open.title} — {open.companyName}</h2>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setOpen(null)}>{t.Close}</button>
          </div>

          {editing ? (
            <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
              <ErrorSummary errors={errors} prefix="review" />
              <SubmissionFields prefix="review" values={editing} errors={errors} disabled={busy}
                onChange={(p) => setEditing({ ...editing, ...p })} />
              <div className="d-flex gap-2">
                <button type="submit" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy}>{t.SaveChanges}</button>
                <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => { setEditing(null); setErrors({}); }}>{t.Cancel}</button>
              </div>
            </form>
          ) : (
            <>
              <dl className="row mb-2">
                <dt className="col-sm-3">{t.City}</dt><dd className="col-sm-9">{open.city ?? open.citySymbol}</dd>
                <dt className="col-sm-3">{t.JobScope}</dt><dd className="col-sm-9">{open.jobScope.map((s) => scopeLabels[s] ?? s).join(', ')}</dd>
                <dt className="col-sm-3">{t.Skills}</dt><dd className="col-sm-9">{open.requiredSkills.map((id) => open.requiredSkillsDetails[id] ?? id).join(', ')}</dd>
                <dt className="col-sm-3">{t.ExternalLink}</dt><dd className="col-sm-9" dir="ltr">{open.externalLink ?? '—'}</dd>
                <dt className="col-sm-3">{t.PublicEmail}</dt><dd className="col-sm-9" dir="ltr">{open.publicEmail ?? '—'}</dd>
                <dt className="col-sm-3">{t.Sent}</dt><dd className="col-sm-9">{fmt(open.createdAt)}</dd>
                {open.status !== 'pending' && <><dt className="col-sm-3">{t.Reviewed}</dt><dd className="col-sm-9">{fmt(open.reviewedAt)} {open.reviewedBy ? `${t.By} ${open.reviewedBy}` : ''}</dd></>}
                {open.rejectReason && <><dt className="col-sm-3">{t.RejectReason}</dt><dd className="col-sm-9" style={{ whiteSpace: 'pre-wrap' }}>{open.rejectReason}</dd></>}
              </dl>
              <h3 className="fs-6 font-RubikBold">{t.Description}</h3>
              {/* Plain text from the public: shown as text, never as HTML. */}
              <div dir="auto" className="border rounded p-2 mb-3" style={{ whiteSpace: 'pre-wrap' }}>{open.description}</div>

              <h3 className="fs-6 font-RubikBold">{t.ContactSection}</h3>
              <p className="small text-muted mb-1">{t.ContactNote}</p>
              <dl className="row">
                <dt className="col-sm-3">{t.ContactName}</dt><dd className="col-sm-9">{open.contactName}</dd>
                <dt className="col-sm-3">{t.ContactEmail}</dt><dd className="col-sm-9" dir="ltr"><a href={`mailto:${open.contactEmail}`}>{open.contactEmail}</a></dd>
                <dt className="col-sm-3">{t.ContactPhone}</dt><dd className="col-sm-9" dir="ltr">{open.contactPhone}</dd>
                <dt className="col-sm-3">{t.ConsentAt}</dt><dd className="col-sm-9">{fmt(open.consentAt)}</dd>
              </dl>

              {open.status === 'approved' && open.jobId && <a href={`/job/${open.jobId}`} target="_blank" rel="noopener noreferrer">{t.ViewJob}</a>}

              {open.status === 'pending' && (
                rejecting ? (
                  <div className="mt-3">
                    <label htmlFor="reject-reason" className="form-label">{t.RejectReason}</label>
                    <textarea id="reject-reason" className="form-control mb-2" rows={3} maxLength={500} value={reason}
                      onChange={(e) => setReason(e.target.value)} />
                    <div className="d-flex gap-2">
                      <button type="button" className="btn btn-danger rounded-pill px-4" disabled={busy} onClick={reject}>{t.ConfirmReject}</button>
                      <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => setRejecting(false)}>{t.Cancel}</button>
                    </div>
                  </div>
                ) : (
                  <div className="d-flex gap-2 mt-3 flex-wrap">
                    <button type="button" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy} onClick={approve}>{t.Approve}</button>
                    <button type="button" className="btn btn-outline-dark rounded-pill px-4" disabled={busy} onClick={() => { setEditing(toValues(open)); setErrors({}); }}>{t.Edit}</button>
                    <button type="button" className="btn btn-outline-danger rounded-pill px-4" disabled={busy} onClick={() => setRejecting(true)}>{t.Reject}</button>
                  </div>
                )
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
};

export default JobSubmissionsReview;
