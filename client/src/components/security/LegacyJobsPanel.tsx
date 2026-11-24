// The existing site's jobs and the cutover report, inside the Salesforce card (admins). Counts, job ids and codes
// only. "קרא עכשיו" reads Salesforce (never writes); the cutover report reads Salesforce too.
// Server: server/src/services/legacyJobs.ts, controllers/salesforceAdminController.ts. Guide: docs/jobs-management.md.
import { useEffect, useState } from 'react';
import { Chip, api, fmtDateTime, relTime } from './ui';

type Counts = { read: number; created: number; updated: number; unchanged: number; closed: number; skipped: Record<string, number> };
type Summary = {
  mode: 'off' | 'mirror' | 'owned'; mirrorActive: boolean; everyMinutes: number; publicApiSet: boolean;
  state: { watermark: string | null; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; last: Counts | null; publicApi: string };
  jobs: { mirror: number; owned: number; active: number; suspended: number; closed: number; withoutCase: number };
};
type IdList = { count: number; ids: string[] };
type Cutover = {
  at: string; betaMark: boolean; legacy: Summary;
  jobs: { ok: boolean; code?: string; positionCases?: number; truncated?: boolean; byStatus?: Record<string, number>;
    notHere?: IdList; sameIdMadeHere?: IdList; activeThereNotHere?: IdList; activeHereNotThere?: IdList; hereWithoutCase?: IdList };
  candidates: { total: number; inSalesforce: number; adoptedByEmail: number; ambiguousEmail: number; madeHere: number; notSent: number };
};

const MODE_LABEL: Record<Summary['mode'], string> = {
  off: 'כבוי — לא נקרא כלום',
  mirror: 'מראה — האתר הקיים מנהל את המשרות, כאן הן לקריאה בלבד',
  owned: 'אחרי המעבר — המשרות מנוהלות כאן ונכתבות לאותו Case',
};
const SKIP_LABEL: Record<string, string> = {
  bad_pid: 'מזהה משרה לא תקין', no_title: 'בלי כותרת', no_city: 'בלי יישוב', not_legacy: 'מזהה של משרה שנוצרה כאן',
  owned_here: 'כבר מנוהלת כאן', db_error: 'שגיאת שמירה',
};

const Ids = ({ label, list }: { label: string; list?: IdList }) => (!list ? null : (
  <li>{label}: <b>{list.count}</b>
    {list.ids.length > 0 && <div className="sec-ltr sec-muted small">{list.ids.join(' · ')}{list.count > list.ids.length ? ' …' : ''}</div>}
  </li>
));

export default function LegacyJobsPanel() {
  const [s, setS] = useState<Summary | null>(null);
  const [report, setReport] = useState<Cutover | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = () => api('/admin/security/salesforce/legacy-jobs').then((d: Summary) => { setS(d); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const run = async (full: boolean) => {
    setBusy(full ? 'full' : 'run');
    try {
      const r = await api('/admin/security/salesforce/legacy-jobs/run', { method: 'POST', body: JSON.stringify({ full }) });
      window.alert(`נקראו ${r.counts.read}: נוספו ${r.counts.created}, עודכנו ${r.counts.updated}, נסגרו ${r.counts.closed}`);
      await load();
    } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(''); }
  };
  const loadReport = async () => {
    setBusy('report');
    try { setReport(await api('/admin/security/salesforce/cutover-report')); } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(''); }
  };

  if (!s) return <div className="mt-3"><h3 className="fs-6">משרות האתר הקיים</h3><p className="sec-empty">{error || 'טוען…'}</p></div>;
  const last = s.state.last;
  return (
    <div className="mt-3" aria-labelledby="sec-legacy-h">
      <div className="sec-card__head">
        <h3 className="fs-6" id="sec-legacy-h">משרות האתר הקיים{' '}
          {s.mode === 'mirror' ? <Chip tone={s.mirrorActive ? 'ok' : 'alert'}>{s.mirrorActive ? 'מראה פעילה' : 'מראה — Salesforce כבוי'}</Chip>
            : s.mode === 'owned' ? <Chip tone="ok">מנוהלות כאן</Chip> : <Chip tone="muted">כבוי</Chip>}
        </h3>
        <div className="d-flex gap-2 flex-wrap">
          {s.mirrorActive && <button type="button" className="sec-btn" disabled={!!busy} onClick={() => run(false)}>
            <i className="bi bi-arrow-repeat" aria-hidden="true" />{busy === 'run' ? 'קורא…' : 'קרא עכשיו מ-Salesforce'}</button>}
          {s.mirrorActive && <button type="button" className="sec-btn" disabled={!!busy} onClick={() => run(true)}>
            <i className="bi bi-collection" aria-hidden="true" />{busy === 'full' ? 'קורא…' : 'קריאה מלאה'}</button>}
          <button type="button" className="sec-btn" disabled={!!busy} onClick={loadReport}>
            <i className="bi bi-clipboard-check" aria-hidden="true" />{busy === 'report' ? 'מכין…' : 'דוח התאמה למעבר'}</button>
        </div>
      </div>
      <p className="sec-card__hint">
        {MODE_LABEL[s.mode]} (<span className="sec-ltr">LEGACY_JOBS_MODE={s.mode}</span>).
        {s.mirrorActive ? ` נקרא מ-Salesforce כל ${s.everyMinutes} דקות; רק קריאה, בלי כתיבה.` : ''}
        {s.state.lastOkAt ? ` קריאה אחרונה: ${relTime(s.state.lastOkAt)}.` : ''}
        {s.state.lastError ? <> <Chip tone="alert">תקלה</Chip> <span className="sec-ltr">{s.state.lastError}</span></> : null}
      </p>
      <ul className="list-unstyled small">
        <li>כאן: {s.jobs.mirror + s.jobs.owned} משרות ({s.jobs.active} פעילות, {s.jobs.suspended} מושהות, {s.jobs.closed} סגורות)
          {s.jobs.withoutCase ? ` · ${s.jobs.withoutCase} בלי Case (מהלוח הציבורי בלבד)` : ''}</li>
        <li>הלוח הציבורי של האתר הקיים: {!s.publicApiSet ? 'לא מוגדר' : s.state.publicApi === 'ok' ? 'נקרא' : <span className="sec-ltr">{s.state.publicApi}</span>}</li>
        {last && <li>בקריאה האחרונה: נקראו {last.read}, נוספו {last.created}, עודכנו {last.updated}, נסגרו {last.closed}
          {Object.keys(last.skipped).length > 0 && <> · דולגו: {Object.entries(last.skipped).map(([k, n]) => `${SKIP_LABEL[k] ?? k} ${n}`).join(', ')}</>}</li>}
      </ul>
      {report && (
        <div className="mt-2">
          <h4 className="fs-6">דוח התאמה <span className="sec-muted">{fmtDateTime(report.at)}</span></h4>
          <p className="small mb-1">סימון Beta: {report.betaMark ? 'פעיל' : 'כבוי'}</p>
          {report.jobs.ok ? (
            <ul className="small">
              <li>Cases של משרות האתר הקיים ב-Salesforce: <b>{report.jobs.positionCases}</b>{report.jobs.truncated ? ' (חלקי)' : ''}
                {report.jobs.byStatus && <span className="sec-muted"> ({Object.entries(report.jobs.byStatus).map(([k, n]) => `${k}: ${n}`).join(', ')})</span>}</li>
              <Ids label="יש Case ואין משרה כאן" list={report.jobs.notHere} />
              <Ids label="פעילה ב-Salesforce, לא פעילה כאן" list={report.jobs.activeThereNotHere} />
              <Ids label="פעילה כאן, לא פעילה ב-Salesforce" list={report.jobs.activeHereNotThere} />
              <Ids label="משרה של האתר הקיים כאן בלי Case" list={report.jobs.hereWithoutCase} />
              <Ids label="מזהה של משרה שנוצרה כאן" list={report.jobs.sameIdMadeHere} />
            </ul>
          ) : <p className="small"><Chip tone="alert">לא נקרא</Chip> <span className="sec-ltr">{report.jobs.code}</span></p>}
          <ul className="small">
            <li>מועמדים רשומים: {report.candidates.total} · ב-Salesforce: {report.candidates.inSalesforce} · עוד לא נשלחו: {report.candidates.notSent}</li>
            <li>Contact קיים שנמצא לפי מייל: <b>{report.candidates.adoptedByEmail}</b>
              {report.candidates.ambiguousEmail ? <> (מתוכם <b>{report.candidates.ambiguousEmail}</b> עם כמה Contacts באותו מייל — לבדיקת הצוות)</> : null}
              {' '}· Contact חדש: {report.candidates.madeHere}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
