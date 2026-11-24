// "מועמדים למשרות שלי" in the employer's area (/employer). docs/employers.md "Applicants".
// Only the applicants the SKEELZ team forwarded: name, forward date, CV. Loaded only when the employer asks (every
// load is logged and counted in their daily limit on the server, and marks the applicants as seen). No candidate id
// or name goes into a path, a page title or an analytics event: the CV is fetched by the forward id and downloaded.
import React, { useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import { ApiError, api, fmtDate } from './employerApi';

type Applicant = { forwardId: string; name: string; forwardedAt: string; hasCv: boolean };
type JobGroup = { jobId: string; jobNumber: number; title: string; active: boolean; accessUntil: string | null; applicants: Applicant[] };

const EmployerApplicants: React.FC<{ card: string }> = ({ card }) => {
  useLanguageStore();
  const t = i18n.getTranslations().EmployerApplicants;
  const [jobs, setJobs] = useState<JobGroup[] | null>(null);
  const [cut, setCut] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = async () => {
    setBusy(true); setMessage(null);
    try {
      const d = await api<{ jobs: JobGroup[]; cut: number }>('/employer/applicants');
      setJobs(d.jobs); setCut(d.cut);
    } catch (e) {
      setMessage({ kind: 'error', text: (e as ApiError).message });
    } finally { setBusy(false); }
  };

  const openCv = async (a: Applicant) => {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/employer/applicants/${encodeURIComponent(a.forwardId)}/cv`, { credentials: 'same-origin' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new ApiError(b.message || `HTTP ${res.status}`, res.status, b.code);
      }
      const type = res.headers.get('content-type') || 'application/octet-stream';
      const name = (res.headers.get('content-disposition') || '').match(/filename="?([^";]+)"?/)?.[1] || 'cv';
      const url = URL.createObjectURL(new Blob([await res.blob()], { type }));
      const link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMessage({ kind: 'ok', text: t.CvOpened });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as ApiError).message });
    } finally { setBusy(false); }
  };

  return (
    <section className={card} aria-labelledby="my-applicants">
      <h2 id="my-applicants" className="fs-5 font-RubikBold">{t.Title}</h2>
      <p className="small text-muted">{t.Intro}</p>
      <div aria-live="polite">{message && <div className={`alert ${message.kind === 'ok' ? 'alert-success' : 'alert-danger'} py-2`}>{message.text}</div>}</div>
      {jobs === null ? (
        <button type="button" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy} onClick={load}>{t.Show}</button>
      ) : (
        <>
          {cut > 0 && <p role="alert" className="text-danger small">{t.Cut}</p>}
          {jobs.length === 0 ? <p className="mb-0">{t.None}</p> : jobs.map((j) => (
            <div key={j.jobId} className="border rounded-3 p-3 mb-3">
              <h3 className="fs-6 font-RubikBold mb-1">{j.title} <span className="text-muted small">#{j.jobNumber}</span></h3>
              <p className="small text-muted mb-2">{j.active || !j.accessUntil ? t.JobOpen : `${t.AccessUntil} ${fmtDate(j.accessUntil)}`}</p>
              <ul className="list-unstyled mb-0">
                {j.applicants.map((a) => (
                  <li key={a.forwardId} className="d-flex justify-content-between align-items-center flex-wrap gap-2 border-top py-2">
                    <div>
                      <div className="font-RubikMedium">{a.name}</div>
                      <div className="small text-muted">{t.ForwardedAt} {fmtDate(a.forwardedAt)}</div>
                    </div>
                    {a.hasCv ? (
                      <button type="button" className="btn btn-sm btn-outline-dark rounded-pill px-3" disabled={busy}
                        onClick={() => openCv(a)} aria-label={`${t.OpenCv}: ${a.name}`}>{t.OpenCv}</button>
                    ) : <span className="small text-muted">{t.NoCv}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
};

export default EmployerApplicants;
