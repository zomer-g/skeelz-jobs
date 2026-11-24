// Salesforce on the admin security screen: on/off and what to fix (names only), a READ-ONLY connection check,
// counts per kind, recent failures (kind, record id, error code — never data) and retry. Records from before the
// switch-on are only counted ("לא נשלחו"): they are never sent (owner's rule, 11.2026).
// Server: server/src/controllers/salesforceAdminController.ts. Every action here is recorded. Guide: docs/salesforce.md.
import { useEffect, useState } from 'react';
import { Chip, Help, api, fmtDateTime, relTime } from './ui';
import LegacyJobsPanel from './LegacyJobsPanel';

type Counts = { synced: number; queued: number; retrying: number; failed: number; neverSent: number };
type CheckItem = { id: string; ok: boolean; warn?: boolean; label: string; code?: string; detail?: string[] };
type Report = { ok: boolean; at: string; enabled: boolean; items: CheckItem[] };
type State = {
  requested: boolean; enabled: boolean; problems: string[]; apiVersion: string;
  settings: { name: string; required: boolean; secret: boolean; set: boolean; value?: string }[];
  counts: Record<string, Counts>;
  failures: { kind: string; recordId: string; sfId: string | null; code: string; attempts: number; lastAttemptAt: string; nextAttemptAt: string | null; willRetry: boolean }[];
  lastPushedAt: string | null;
  lastCheck: Report | null;
};

const KIND_LABELS: Record<string, string> = {
  job: 'משרות (שנוצרו כאן)', candidate: 'מועמדים רשומים', employer: 'מעסיקים (איש קשר + חשבון החברה)', application: 'הגשות', guest_application: 'הגשות מהירות',
};
/** Readable meaning of the common codes (the code itself is always shown too). */
const CODE_HINTS: [RegExp, string][] = [
  [/beta_field_missing/, 'אין תיבת סימון Beta שאפשר לערוך באובייקט: לא נשלח כלום'],
  [/threshold_fields_missing/, 'שדה של תנאי סף חסר ב-Case (או בלי הרשאת עריכה): השדה הזה לא נשלח, כל השאר כן'],
  [/employer_id_field_missing/, 'חסר השדה SKEELZ_Employer_Id__c ב-Contact או ב-Account: מעסיקים לא נשלחים'],
  [/^auth_invalid_client/, 'פרטי ה-External Client App שגויים, או ש-Client Credentials לא מסומן בשני המקומות'],
  [/^auth_invalid_grant/, 'אין "Run As" למשתמש האינטגרציה, או שהמשתמש לא פעיל'],
  [/^auth/, 'ההתחברות ל-Salesforce נכשלה'],
  [/DUPLICATES_DETECTED/, 'חוק כפילויות ב-Salesforce חסם את הרשומה'],
  [/REQUIRED_FIELD_MISSING|FIELD_CUSTOM_VALIDATION/, 'שדה חובה או חוק אימות ב-Salesforce'],
  [/INVALID_FIELD|fields_missing/, 'שדה חסר באובייקט, או שאין למשתמש הרשאת עריכה לשדה'],
  [/INSUFFICIENT_ACCESS|http_403/, 'חסרה הרשאה ב-Permission Set'],
  [/^http_5|^net_/, 'תקלה זמנית — ניסיון חוזר אוטומטי'],
  [/^cv_/, 'הרשומה נוצרה אבל קובץ קורות החיים לא עלה'],
  [/legacy_case_not_editable/, 'משתמש האינטגרציה לא יכול לערוך את ה-Cases של משרות האתר הקיים: צריך Sharing Rule לפני המעבר'],
  [/legacy_no_job_yet/, 'עוד לא נקראה משרה של האתר הקיים'],
];
const hintOf = (code?: string) => (code ? CODE_HINTS.find(([re]) => re.test(code))?.[1] : undefined);

export default function SalesforceSync() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState<Report | null>(null);

  const load = () => api('/admin/security/salesforce').then((d: State) => { setData(d); setError(''); setReport((r) => r ?? d.lastCheck); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const post = async (path: string, body: unknown, label: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label);
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (path.endsWith('/check')) setReport(r);
      else window.alert(`נכנסו לתור: ${r.queued}`);
      await load();
    } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(''); }
  };

  if (!data) return <section className="sec-card" aria-busy="true"><h2>Salesforce</h2><p className="sec-empty">{error || 'טוען…'}</p></section>;
  const status = data.enabled ? <Chip tone="ok">פעיל</Chip>
    : data.requested ? <Chip tone="alert">מבוקש אבל כבוי — יש מה לתקן</Chip> : <Chip tone="muted">כבוי</Chip>;
  const totalFailed = Object.values(data.counts).reduce((n, c) => n + c.failed + c.retrying, 0);

  return (
    <section className="sec-card" aria-labelledby="sec-sf-h" id="salesforce" tabIndex={-1}>
      <div className="sec-card__head">
        <h2 id="sec-sf-h">Salesforce {status}</h2>
        <button type="button" className="sec-btn sec-btn--primary" disabled={!!busy}
          onClick={() => post('/admin/security/salesforce/check', {}, 'check')}>
          <i className="bi bi-plug" aria-hidden="true" />{busy === 'check' ? 'בודק…' : 'בדיקת חיבור'}
        </button>
      </div>
      <p className="sec-card__hint">
        מה האתר שולח ל-Salesforce ומה נתקע. בדיקת החיבור קוראת בלבד — לא יוצרת ולא משנה דבר.
        {data.lastPushedAt ? ` שליחה אחרונה: ${relTime(data.lastPushedAt)}.` : ''}
      </p>
      <Help>
        <p>כל שינוי באתר (הרשמה, עדכון פרטים, הגשה, הגשה מהירה, משרה שנוצרה כאן, מעסיק) נכנס לתור ונשלח ברקע. תקלה זמנית
          נשלחת שוב אוטומטית בהמתנות הולכות וגדלות; סירוב של Salesforce (למשל שדה חובה) נעצר עד ש"ננסה שוב". אין כפילויות:
          כל רשומה נמצאת לפי המזהה שלה. משרות שיובאו מהאתר הקיים לא נשלחות אף פעם. ביומן נרשם מי נשלח, לפני השליחה.</p>
        <p>מה שקרה באתר לפני שהחיבור הודלק לא נשלח (נספר בעמודה "לא נשלחו" בלבד). כל רשומה נשלחת מסומנת Beta.</p>
        <p>ההגדרות הן משתני סביבה בשרת (המדריך: <span className="sec-ltr">docs/salesforce.md</span>). המפתח והסוד לא מוצגים כאן.</p>
      </Help>

      {data.problems.length > 0 && (
        <div role="alert" className="sec-help__body">
          <strong>לתקן בהגדרות השרת:</strong>
          <ul dir="ltr">{data.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      <details>
        <summary>הגדרות (API {data.apiVersion})</summary>
        <ul dir="ltr" className="sec-muted">
          {data.settings.map((s) => (
            <li key={s.name}>{s.name}: {s.set ? (s.value ?? (s.secret ? 'set (secret)' : 'set')) : s.required ? 'MISSING' : '—'}</li>
          ))}
        </ul>
      </details>

      {report && (
        <div className="mt-2">
          <h3 className="fs-6">בדיקת חיבור {report.ok ? <Chip tone="ok">תקין</Chip> : <Chip tone="alert">יש מה לתקן</Chip>}
            <span className="sec-muted"> {fmtDateTime(report.at)}</span></h3>
          <ul className="list-unstyled">
            {report.items.map((i) => (
              <li key={i.id}>
                <Chip tone={!i.ok ? 'alert' : i.warn ? 'warn' : 'ok'}>{i.label}</Chip>
                {i.code && <span className="sec-ltr sec-muted"> {i.code}</span>}
                {hintOf(i.code) && <span className="sec-muted"> — {hintOf(i.code)}</span>}
                {i.detail?.length ? <div className="sec-ltr sec-muted small">{i.detail.join(' · ')}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className="sec-table sec-table--stack mt-2">
        <thead><tr><th scope="col">סוג</th><th scope="col">נשלחו</th><th scope="col">בתור</th><th scope="col">נכשלו</th><th scope="col">לא נשלחו</th></tr></thead>
        <tbody>
          {Object.entries(data.counts).map(([kind, c]) => (
            <tr key={kind}>
              <td className="sec-cell-main">{KIND_LABELS[kind] ?? kind}</td>
              <td data-label="נשלחו">{c.synced}</td>
              <td data-label="בתור">{c.queued + c.retrying}</td>
              <td data-label="נכשלו">{c.failed + c.retrying ? <Chip tone="warn">{c.failed + c.retrying}</Chip> : 0}</td>
              <td data-label="לא נשלחו">{c.neverSent}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.failures.length > 0 && (
        <>
          <div className="sec-card__head mt-3">
            <h3 className="fs-6">תקלות אחרונות ({totalFailed})</h3>
            {data.enabled && <button type="button" className="sec-btn" disabled={!!busy} onClick={() => post('/admin/security/salesforce/retry', {}, 'retry')}>
              <i className="bi bi-arrow-repeat" aria-hidden="true" />ננסה שוב את כולן
            </button>}
          </div>
          <table className="sec-table sec-table--stack">
            <thead><tr><th scope="col">סוג</th><th scope="col">מזהה רשומה</th><th scope="col">קוד</th><th scope="col">ניסיונות</th><th scope="col">ניסיון אחרון</th><th scope="col">הבא</th></tr></thead>
            <tbody>
              {data.failures.map((f) => (
                <tr key={`${f.kind}:${f.recordId}`}>
                  <td className="sec-cell-main">{KIND_LABELS[f.kind] ?? f.kind}</td>
                  <td data-label="מזהה"><span className="sec-ltr">{f.recordId}</span></td>
                  <td data-label="קוד"><span className="sec-ltr">{f.code}</span>{hintOf(f.code) && <div className="sec-muted small">{hintOf(f.code)}</div>}</td>
                  <td data-label="ניסיונות">{f.attempts}</td>
                  <td data-label="ניסיון אחרון">{relTime(f.lastAttemptAt)}</td>
                  <td data-label="הבא">{f.willRetry ? (f.nextAttemptAt ? relTime(f.nextAttemptAt) : 'בקרוב') : <Chip tone="alert">ממתין ל"ננסה שוב"</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <LegacyJobsPanel />
    </section>
  );
}
