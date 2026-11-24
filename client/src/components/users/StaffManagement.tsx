// Staff users (admins only, /staff-management): list staff, add one (dialog), change a role, deactivate /
// reactivate, close sessions. Lists staff accounts only. Same look as the security screen (`.sec-*`).
// Server: server/src/controllers/staffController.ts. Every action is recorded in the activity log.
import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '../../i18n/General.enums';
import { Chip, Dialog, Help, api, relTime } from '../security/ui';

type Staff = {
  id: string; email: string; firstName: string; lastName: string; role: string;
  active: boolean; createdAt: string; invitePending: boolean; lastLogin: string | null;
  /** Several roles per account (23.11.2026): the person is also a candidate / an employer (no data, just the fact). */
  alsoCandidate?: boolean; alsoEmployer?: boolean;
};
type Data = { roles: string[]; me: string; staff: Staff[] };

const EMPTY = { email: '', firstName: '', lastName: '', role: 'content_manager' };

export default function StaffManagement() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = () => api('/admin/staff').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true);
    try { await fn(); await load(); return true; }
    catch (e) { window.alert((e as Error).message); return false; }
    finally { setBusy(false); }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = form.email.trim();
    if (!email) return;
    const ok = await act(async () => {
      const r = await api('/admin/staff', { method: 'POST', body: JSON.stringify({ ...form, email }) });
      if (r.created) {
        setNotice(r.emailSent
          ? `${email} נוסף/ה. נשלח מייל שמסביר איך להיכנס ("המשך עם Google").`
          : `${email} נוסף/ה. שליחת מיילים כבויה — אמרו לו/לה להיכנס ב"התחברות" ← "המשך עם Google" עם חשבון ה-Google של המייל הזה.`);
      } else if (r.changed) {
        const also = [r.alsoCandidate && 'מועמד/ת', r.alsoEmployer && 'מעסיק'].filter(Boolean).join(' ו');
        setNotice(`לחשבון הקיים ${email} נוסף התפקיד ${ROLE_LABELS[form.role]}${also ? ` (הוא נשאר גם ${also})` : ''}. החיבורים שלו נסגרו. הרשאות הצוות פועלות רק בכניסה עם "המשך עם Google".`);
      } else {
        setNotice(`ל-${email} כבר יש את התפקיד ${ROLE_LABELS[form.role]}.`);
      }
    });
    if (ok) { setOpen(false); setForm({ ...EMPTY, role: form.role }); }
  };

  if (error && !data) return <div dir="rtl" className="board-frame sec-page"><p role="alert">{error}</p></div>;
  if (!data) return <div dir="rtl" className="board-frame sec-page"><p aria-busy="true">טוען…</p></div>;
  const activeAdmins = data.staff.filter((s) => s.role === 'admin' && s.active).length;
  const counts = {
    admin: data.staff.filter((s) => s.role === 'admin' && s.active).length,
    content_manager: data.staff.filter((s) => s.role === 'content_manager' && s.active).length,
    placement_coordinator: data.staff.filter((s) => s.role === 'placement_coordinator' && s.active).length,
    inactive: data.staff.filter((s) => !s.active).length,
  };

  return (
    <div dir="rtl" className="board-frame sec-page">
      <div className="sec-page__head">
        <div>
          <h1 className="font-EzerRegularLoft display-6">צוות והרשאות</h1>
          <p className="sec-page__sub">{counts.admin} מנהלי מערכת · {counts.content_manager} מנהלי תוכן · {counts.placement_coordinator} רכזי השמה{counts.inactive ? ` · ${counts.inactive} מושבתים` : ''}</p>
        </div>
        <button type="button" className="board-pill board-pill--employer" onClick={() => { setForm(EMPTY); setOpen(true); }}>
          <i className="bi bi-person-plus" aria-hidden="true" /> הוספת איש צוות
        </button>
      </div>

      {notice && <p className="sec-note sec-note--ok" role="status">{notice}</p>}

      <section className="sec-card" aria-labelledby="staff-h">
        <div className="sec-card__head"><h2 id="staff-h">אנשי צוות</h2></div>
        <Help label="מה כל תפקיד רואה?">
          <ul>
            <li><b>רכז השמה</b> — צפייה במועמדים, בהגשות ובקורות חיים (בתוך המגבלה היומית), וניהול משרות: הוספה, עריכה,
              הקפצה ונעיצה, ארכוב ושחזור, אישור משרות ממעסיקים. בלי תנאי סף, הגדרות הגשה, עריכת מועמדים והעברה למעסיק.</li>
            <li><b>מנהל תוכן</b> — כל מה שרכז השמה עושה, ובנוסף עריכת מועמדים, העברה למעסיק, תנאי סף והגדרות המשרות
              והמועמדים: שדות טופס ההרשמה, מדיניות ההגשה ופרסום משרות ממעסיקים.</li>
            <li><b>מנהל מערכת</b> — כל מה שמנהל תוכן רואה, ובנוסף אבטחה, יומן הפעילות, סקירות הרשאה, צוות ומפתחות API.</li>
          </ul>
          <p>כל שינוי נרשם ביומן ונכנס לתוקף מיד: החיבורים של מי ששונה נסגרים. אי אפשר להוריד או להשבית את מנהל המערכת
            הפעיל האחרון, ואי אפשר להשבית את עצמך. אנשי צוות נכנסים רק ב"המשך עם Google".</p>
        </Help>
        <table className="sec-table sec-table--stack">
          <thead><tr>
            <th scope="col">איש צוות</th><th scope="col">תפקיד</th><th scope="col">מצב</th><th scope="col">כניסה אחרונה</th>
            <th scope="col"><span className="visually-hidden">פעולות</span></th>
          </tr></thead>
          <tbody>
            {data.staff.map((s) => {
              const isMe = s.id === data.me;
              const lastAdmin = s.role === 'admin' && s.active && activeAdmins <= 1;
              const name = [s.firstName, s.lastName].filter(Boolean).join(' ');
              return (
                <tr key={s.id}>
                  <td className="sec-cell-main">
                    <span className="sec-ltr">{s.email}</span>{isMe && <span className="sec-muted"> (את/ה)</span>}
                    {name && <div className="sec-muted">{name}</div>}
                    {(s.alsoCandidate || s.alsoEmployer) && (
                      <div className="d-flex gap-1 mt-1">
                        {s.alsoCandidate && <Chip tone="muted">גם מועמד/ת</Chip>}
                        {s.alsoEmployer && <Chip tone="muted">גם מעסיק</Chip>}
                      </div>
                    )}
                  </td>
                  <td data-label="תפקיד">
                    <label className="visually-hidden" htmlFor={`role-${s.id}`}>תפקיד של {s.email}</label>
                    <select id={`role-${s.id}`} className="form-select form-select-sm" style={{ borderRadius: 999, minWidth: '9rem' }}
                      value={s.role} disabled={busy || lastAdmin}
                      aria-describedby={lastAdmin ? `last-${s.id}` : undefined}
                      onChange={(e) => {
                        const to = e.target.value;
                        act(() => api(`/admin/staff/${s.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: to }) }),
                          `לשנות את התפקיד של ${s.email} ל"${ROLE_LABELS[to]}"?${to === 'user' ? ' הגישה שלו לניהול תוסר.' : ''} החיבורים שלו ייסגרו.`);
                      }}>
                      {data.roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}{r === 'user' ? ' (הסרת גישה)' : ''}</option>)}
                    </select>
                    {lastAdmin && <div id={`last-${s.id}`} className="sec-muted">מנהל המערכת הפעיל האחרון</div>}
                  </td>
                  <td data-label="מצב">
                    {!s.active ? <Chip tone="muted">מושבת</Chip>
                      : s.lastLogin ? <Chip tone="ok">פעיל</Chip> : <Chip tone="warn">עוד לא נכנס</Chip>}
                  </td>
                  <td data-label="כניסה אחרונה">{s.lastLogin ? relTime(s.lastLogin) : '—'}</td>
                  <td><div className="sec-actions">
                    <a className="sec-btn" href={`/security-management?person=${encodeURIComponent(s.id)}`} aria-label={`הפעילות של ${s.email}`}>פעילות</a>
                    <button type="button" className="sec-btn" disabled={busy} aria-label={`ניתוק החיבורים של ${s.email}`}
                      onClick={() => act(() => api(`/admin/staff/${s.id}/revoke-sessions`, { method: 'POST' }),
                        `לסגור עכשיו את כל החיבורים של ${s.email}?${isMe ? ' גם את/ה תנותק/י.' : ''}`)}>ניתוק</button>
                    {s.active ? (
                      <button type="button" className="sec-btn sec-btn--danger" disabled={busy || isMe || lastAdmin}
                        aria-label={`השבתת ${s.email}`} title={isMe ? 'אי אפשר להשבית את עצמך' : lastAdmin ? 'מנהל המערכת הפעיל האחרון' : undefined}
                        onClick={() => act(() => api(`/admin/staff/${s.id}/deactivate`, { method: 'POST' }),
                          `להשבית את ${s.email}? לא יוכל להיכנס עד שיופעל מחדש.`)}>השבתה</button>
                    ) : (
                      <button type="button" className="sec-btn" disabled={busy} aria-label={`הפעלה מחדש של ${s.email}`}
                        onClick={() => act(() => api(`/admin/staff/${s.id}/activate`, { method: 'POST' }))}>הפעלה מחדש</button>
                    )}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <Dialog open={open} title="הוספת איש צוות" onClose={() => setOpen(false)}>
        <form onSubmit={add}>
          <label className="sec-field">
            <span>מייל (חשבון Google)</span>
            <input className="form-control" type="email" required dir="ltr" autoComplete="off"
              value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-describedby="add-hint" />
            <small id="add-hint" className="sec-muted">אם כבר יש חשבון עם המייל הזה (גם של מועמד/ת או מעסיק), התפקיד נוסף לו. התפקידים האחרים שלו נשארים.</small>
          </label>
          <div className="d-flex gap-2 flex-wrap">
            <label className="sec-field flex-grow-1"><span>שם פרטי</span>
              <input className="form-control" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></label>
            <label className="sec-field flex-grow-1"><span>שם משפחה</span>
              <input className="form-control" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></label>
          </div>
          <label className="sec-field"><span>תפקיד</span>
            <select className="form-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="placement_coordinator">{ROLE_LABELS.placement_coordinator}</option>
              <option value="content_manager">{ROLE_LABELS.content_manager}</option>
              <option value="admin">{ROLE_LABELS.admin}</option>
            </select>
          </label>
          <div className="sec-dialog__actions">
            <button className="sec-btn sec-btn--primary" type="submit" disabled={busy || !form.email.trim()}>הוספה</button>
            <button type="button" className="sec-btn" onClick={() => setOpen(false)}>ביטול</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
