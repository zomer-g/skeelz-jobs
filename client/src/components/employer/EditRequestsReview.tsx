// Staff: employers' edit requests for their published jobs (a tab on /jobs-management/submissions).
// Server: /api/admin/job-edit-requests (contentGate). Per field: when the employer asked → now on the board →
// requested. Approve applies the change to the job (logged); reject keeps the job (optional reason the employer sees).
import React, { useEffect, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import { getLocalizedDictionary } from '../../i18n/i18nHelper';
import { LocalizedDataKey } from '../../i18n/General.enums';
import { ApiError, api, fmtDate } from './employerApi';
import { LocationService } from '../../services/api/Location.service';
import { SkillsService } from '../../services/api/Skills.service';
import { isString } from '../../utils/utils';

type Status = 'pending' | 'approved' | 'rejected' | 'withdrawn';
type Item = {
  id: string; jobId: string; jobNumber: number | null; jobTitle: string | null; status: Status; createdAt: string;
  reviewedAt: string | null; reviewedBy: string | null; rejectReason: string | null; note: string | null; fields: string[];
  employer: { firstName: string; lastName: string; companyName: string } | null;
};
type Comparison = { field: string; base: unknown; current: unknown; requested: unknown; changedSince: boolean; label?: string };
type Full = Item & { comparison: Comparison[]; readOnly: boolean; jobStatus: string | null };

const EditRequestsReview: React.FC = () => {
  const { currentLanguage } = useLanguageStore();
  const t = i18n.getTranslations().Employers;
  const tf = i18n.getTranslations().EmployerForm;
  const scopeLabels = getLocalizedDictionary(LocalizedDataKey.JOB_SCOPE, currentLanguage);
  const [status, setStatus] = useState<Status>('pending');
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<Status, number>>({ pending: 0, approved: 0, rejected: 0, withdrawn: 0 });
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Full | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [cities, setCities] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    LocationService.getInstance().fetchAllLocations().then((r) => {
      if (!isString(r)) setCities(Object.fromEntries(r.map((c: any) => [String(c.citySymbol), c.city])));
    });
    SkillsService.getInstance().fetchSkillsListRequest().then((r) => {
      if (!isString(r)) setSkills(Object.fromEntries(r.skills.map((x: any) => [x._id, x.name])));
    });
  }, []);

  const load = async (s: Status = status) => {
    setLoading(true);
    try {
      const d = await api<{ items: Item[]; counts: Record<Status, number> }>(`/admin/job-edit-requests?status=${s}`);
      setItems(d.items); setCounts(d.counts);
    } catch (e) { setMessage({ kind: 'error', text: (e as Error).message }); } finally { setLoading(false); }
  };
  useEffect(() => { void load(status); }, [status]);
  useEffect(() => { if (open) detailRef.current?.focus(); }, [open?.id]);

  const openOne = async (id: string) => {
    setMessage(null); setRejecting(false); setReason('');
    try { setOpen(await api<Full>(`/admin/job-edit-requests/${id}`)); } catch (e) { setMessage({ kind: 'error', text: (e as Error).message }); }
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try { await fn(); } catch (e) { setMessage({ kind: 'error', text: (e as ApiError).message }); } finally { setBusy(false); }
  };
  const approve = () => act(async () => {
    if (!open || !window.confirm(t.ReviewConfirmApprove)) return;
    await api(`/admin/job-edit-requests/${open.id}/approve`, { method: 'POST', body: '{}' });
    setOpen(null); setMessage({ kind: 'ok', text: t.ReviewApproved }); await load();
  });
  const reject = () => act(async () => {
    if (!open) return;
    await api(`/admin/job-edit-requests/${open.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    setOpen(null); setRejecting(false); setReason(''); setMessage({ kind: 'ok', text: t.ReviewRejected }); await load();
  });

  const label = (k: string) => (({ title: tf.JobTitle, companyName: tf.CompanyName, citySymbol: tf.City, jobScope: tf.JobScope,
    requiredSkills: tf.Skills, description: tf.Description, externalLink: tf.ExternalLink, publicEmail: tf.PublicEmail,
    thresholdCondition: i18n.getTranslations().Threshold.Label } as Record<string, string>)[k] ?? (k.startsWith('customFields') ? tf.ExtraSection : k));
  // Values are shown as text, never as HTML (they come from an employer).
  const show = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === '' || v === false) return '—';
    if (v === true) return 'כן';
    if (field === 'citySymbol') return cities[String(v)] ?? String(v);
    if (field === 'jobScope' && Array.isArray(v)) return v.map((s) => scopeLabels[s] ?? s).join(', ');
    if (field === 'requiredSkills' && Array.isArray(v)) return v.map((s) => skills[s] ?? s).join(', ');
    return Array.isArray(v) ? v.join(', ') : String(v);
  };

  const tabs: [Status, string][] = [['pending', tf.Pending], ['approved', tf.Approved], ['rejected', tf.Rejected], ['withdrawn', t.StatusWithdrawn]];
  const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #ddd', textAlign: 'start', verticalAlign: 'top' };

  return (
    <div>
      <h2 className="fs-4 font-RubikBold mb-3">{t.ReviewEditsTitle}</h2>
      <div role="tablist" aria-label={t.ReviewEditsTitle} className="d-flex gap-2 mb-3 flex-wrap">
        {tabs.map(([s, l]) => (
          <button key={s} type="button" role="tab" aria-selected={status === s}
            className={`btn rounded-pill ${status === s ? 'bg-color-purple text-white' : 'btn-outline-dark'}`}
            onClick={() => { setOpen(null); setStatus(s); }}>{l} ({counts[s]})</button>
        ))}
      </div>
      <div aria-live="polite">{message && <div className={`alert ${message.kind === 'ok' ? 'alert-success' : 'alert-danger'}`}>{message.text}</div>}</div>

      {loading ? <p>{tf.Loading}</p> : items.length === 0 ? <p>{tf.NoItems}</p> : (
        <div className="table-responsive">
          <table className="w-100 mb-4" style={{ borderCollapse: 'collapse', minWidth: 620 }}>
            <thead><tr>
              <th style={cell}>{t.ReviewJob}</th><th style={cell}>{t.ReviewEmployer}</th><th style={cell}>{t.Fields}</th>
              <th style={cell}>{tf.Sent}</th>{status !== 'pending' && <th style={cell}>{tf.Reviewed}</th>}<th style={cell}><span className="visually-hidden">{tf.Open}</span></th>
            </tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} style={open?.id === r.id ? { background: '#f3f0ff' } : undefined}>
                  <td style={cell}>{r.jobTitle ?? r.jobId}{r.jobNumber ? <span className="small text-muted"> #{r.jobNumber}</span> : null}</td>
                  <td style={cell}>{r.employer ? `${r.employer.firstName} ${r.employer.lastName} · ${r.employer.companyName}` : '—'}</td>
                  <td style={cell}>{r.fields.map(label).join(', ')}</td>
                  <td style={cell}>{fmtDate(r.createdAt, true)}</td>
                  {status !== 'pending' && <td style={cell}>{fmtDate(r.reviewedAt, true)} {r.reviewedBy && r.reviewedBy !== 'self' ? `${tf.By} ${r.reviewedBy}` : ''}</td>}
                  <td style={cell}><button type="button" className="btn btn-sm btn-outline-dark" onClick={() => openOne(r.id)} aria-label={`${tf.Open}: ${r.jobTitle ?? ''}`}>{tf.Open}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <section aria-labelledby="edit-request-title" className="border rounded p-3" style={{ maxWidth: 1100 }}>
          <div className="d-flex justify-content-between align-items-start gap-2">
            <h3 id="edit-request-title" ref={detailRef} tabIndex={-1} className="fs-5 font-RubikBold">{open.jobTitle ?? open.jobId}</h3>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setOpen(null)}>{tf.Close}</button>
          </div>
          <p className="small mb-2">
            <a href={`/job/${open.jobId}`} target="_blank" rel="noopener noreferrer">{tf.ViewJob}</a>
            {open.readOnly && <span className="ms-2 me-2 text-muted"><i className="bi bi-lock" aria-hidden="true" /> {t.ReadOnly}</span>}
          </p>
          {open.note && <p className="mb-2"><span className="font-RubikMedium">{t.ReviewNote}:</span> <span style={{ whiteSpace: 'pre-wrap' }}>{open.note}</span></p>}
          <div className="table-responsive">
            <table className="w-100 mb-3" style={{ borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr><th style={cell}>{t.ReviewField}</th><th style={cell}>{t.ReviewBase}</th><th style={cell}>{t.ReviewCurrent}</th><th style={cell}>{t.ReviewRequested}</th></tr></thead>
              <tbody>
                {open.comparison.map((c) => (
                  <tr key={c.field}>
                    <th scope="row" style={cell}>{c.label ?? label(c.field)}</th>
                    <td style={{ ...cell, whiteSpace: 'pre-wrap' }} dir="auto">{show(c.field, c.base)}</td>
                    <td style={{ ...cell, whiteSpace: 'pre-wrap', ...(c.changedSince ? { background: '#fff4d6' } : {}) }} dir="auto">
                      {show(c.field, c.current)}{c.changedSince && <div className="small font-RubikMedium">{t.ReviewChangedSince}</div>}
                    </td>
                    <td style={{ ...cell, whiteSpace: 'pre-wrap', background: '#eaf7ee' }} dir="auto">{show(c.field, c.requested)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open.status === 'rejected' && open.rejectReason && <p><span className="font-RubikMedium">{tf.RejectReason}:</span> {open.rejectReason}</p>}
          {open.status === 'pending' && !open.readOnly && (rejecting ? (
            <div className="mt-2">
              <label htmlFor="edit-reject-reason" className="form-label">{t.ReviewRejectReason}</label>
              <textarea id="edit-reject-reason" className="form-control mb-2" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="d-flex gap-2">
                <button type="button" className="btn btn-danger rounded-pill px-4" disabled={busy} onClick={reject}>{t.ReviewConfirmReject}</button>
                <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => setRejecting(false)}>{tf.Cancel}</button>
              </div>
            </div>
          ) : (
            <div className="d-flex gap-2 flex-wrap">
              <button type="button" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy} onClick={approve}>{t.ReviewApprove}</button>
              <button type="button" className="btn btn-outline-danger rounded-pill px-4" disabled={busy} onClick={() => setRejecting(true)}>{t.ReviewReject}</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

export default EditRequestsReview;
