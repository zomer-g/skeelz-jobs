// "פעילות של חשבון": everything one account did — sign-ins with address and device, failed attempts on it,
// applications, CV uploads, and (for staff) views of candidates. Admins only (GET /api/admin/audit/person); opening
// it is itself recorded (audit.person_viewed). For a candidate or an employer it shows the id and role, never the email.
import { useEffect, useRef, useState } from 'react';
import { ROLE_LABELS } from '../../i18n/General.enums';
import { Chip, api, fmtDateTime, relTime } from './ui';

type Entry = { id: number; at: string; actor: string; action: string; target: string | null; details: any };
type Person = {
  account: { id: string; ref: string; role: string; email: string | null; createdAt: string; deactivated: boolean };
  totals: { signins: number; failures: number; applications: number; uploads: number; views: number };
  addresses: { ip: string; device: string; n: number; first: string; last: string }[];
  entries: Entry[];
  next: number | null;
};

const GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'הכול' },
  { value: 'signins', label: 'כניסות' },
  { value: 'applications', label: 'הגשות' },
  { value: 'uploads', label: 'קורות חיים' },
  { value: 'views', label: 'צפייה במועמדים' },
];

/** The actor forms that are an account (staff email or user:<id>), as opposed to anonymous:/system:/token:. */
export const isAccountActor = (actor: string) => actor.startsWith('user:') || /^[^:\s]+@[^\s]+$/.test(actor);

const Stat: React.FC<{ n: number; label: string; tone?: 'warn' }> = ({ n, label, tone }) => (
  <li className={`sec-person__stat${tone ? ' sec-person__stat--warn' : ''}`}><span className="sec-person__num">{n}</span> {label}</li>
);

export default function PersonActivity({ who, labels, onClose }: { who: string; labels: Record<string, string>; onClose: () => void }) {
  const [data, setData] = useState<Person | null>(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);

  const load = async (before?: number) => {
    const q = new URLSearchParams({ who });
    if (group) q.set('group', group);
    if (before) q.set('before', String(before));
    setBusy(true);
    try {
      const r: Person = await api(`/admin/audit/person?${q}`);
      setData((prev) => (before && prev ? { ...r, entries: [...prev.entries, ...r.entries] } : r));
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [who, group]);
  useEffect(() => { headRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); headRef.current?.focus(); }, [who]);

  const a = data?.account;
  const title = a ? (a.email ?? a.ref) : who;
  return (
    <section className="sec-card sec-person" aria-labelledby="sec-person-h">
      <div className="sec-card__head">
        <h2 id="sec-person-h" ref={headRef} tabIndex={-1}>פעילות של חשבון: <span className="sec-ltr">{title}</span></h2>
        <button type="button" className="sec-btn" onClick={onClose} aria-label="סגירת הפעילות של החשבון">סגירה</button>
      </div>
      {error && <p role="alert" className="sec-note sec-note--alert">{error}</p>}
      {!data && !error && <p aria-busy="true">טוען…</p>}
      {data && a && (
        <>
          <p className="sec-card__hint">
            {ROLE_LABELS[a.role] ?? a.role} · נוצר {fmtDateTime(a.createdAt)}{a.deactivated ? ' · ' : ''}{a.deactivated && <Chip tone="muted">מושבת</Chip>}
            {!a.email && <> · <span className="sec-ltr">{a.ref}</span> (מועמד או מעסיק: מזהה בלבד, בלי מייל)</>}
          </p>
          <ul className="sec-person__stats" aria-label="סיכום">
            <Stat n={data.totals.signins} label="כניסות" />
            <Stat n={data.totals.failures} label="ניסיונות שנכשלו או נחסמו" tone={data.totals.failures ? 'warn' : undefined} />
            <Stat n={data.totals.applications} label="הגשות" />
            <Stat n={data.totals.uploads} label="קורות חיים שצורפו" />
            <Stat n={data.totals.views} label="צפיות במועמדים" />
          </ul>

          <h3 className="sec-person__sub">מאיפה נכנס</h3>
          {data.addresses.length === 0 ? <p className="sec-empty">אין עדיין כניסות עם כתובת רשומה.</p> : (
            <table className="sec-table sec-table--stack">
              <thead><tr><th scope="col">כתובת (IP)</th><th scope="col">מכשיר</th><th scope="col">כניסות</th><th scope="col">ראשונה</th><th scope="col">אחרונה</th></tr></thead>
              <tbody>
                {data.addresses.map((r) => (
                  <tr key={`${r.ip}|${r.device}`}>
                    <td className="sec-cell-main sec-ltr">{r.ip}</td>
                    <td data-label="מכשיר" className="sec-ltr">{r.device}</td>
                    <td data-label="כניסות">{r.n}</td>
                    <td data-label="ראשונה">{fmtDateTime(r.first)}</td>
                    <td data-label="אחרונה">{relTime(r.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="sec-person__sub">כל הפעולות</h3>
          <div className="sec-filters" role="group" aria-label="סינון הפעולות">
            <label>הצגה
              <select className="form-select" value={group} onChange={(e) => setGroup(e.target.value)}>
                {GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </select>
            </label>
          </div>
          {data.entries.length === 0 ? <p className="sec-empty">{busy ? 'טוען…' : 'אין רשומות.'}</p> : (
            <ul className="sec-log" aria-live="polite">
              {data.entries.map((e) => (
                <li key={e.id} className="sec-log__item">
                  <time className="sec-log__when" dateTime={e.at} title={fmtDateTime(e.at)}>{relTime(e.at)}</time>
                  <div>
                    <div className="sec-log__what">{labels[e.action] ?? e.action}</div>
                    <div className="sec-log__who">
                      {e.details?.ip && <><span className="sec-muted">כתובת: </span><span className="sec-ltr">{e.details.ip}</span></>}
                      {e.details?.device && <><span className="sec-muted"> · מכשיר: </span><span className="sec-ltr">{e.details.device}</span></>}
                      {e.target ? <><span className="sec-muted">{e.details?.ip ? ' · ' : ''}על: </span><span className="sec-ltr">{e.target}</span></> : null}
                    </div>
                    {e.details && <details><summary>פרטים</summary><pre dir="ltr">{JSON.stringify(e.details, null, 1)}</pre></details>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.next && <button type="button" className="sec-btn mt-2" disabled={busy} onClick={() => load(data.next!)}>עוד רשומות</button>}
        </>
      )}
    </section>
  );
}
