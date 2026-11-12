// Staff users (admins only, /users-management for an admin): list staff, add or invite one, change a role,
// deactivate / reactivate, close sessions. Lists staff accounts only — never candidates.
// Server: server/src/controllers/staffController.ts. Every action is recorded in the activity log.
import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '../../i18n/General.enums';

type Staff = {
  id: string; email: string; firstName: string; lastName: string; role: string;
  active: boolean; createdAt: string; invitePending: boolean; lastLogin: string | null;
};
type Data = { roles: string[]; me: string; staff: Staff[] };

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body.data;
};

const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('he-IL') : '—');
const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #ddd', textAlign: 'right', verticalAlign: 'middle' };

const ROLE_DUTIES: Record<string, string> = {
  content_manager: 'משרות, מועמדים, הגשות וקורות חיים — בתוך המגבלה היומית',
  admin: 'אבטחה, יומן הפעילות, התראות, סקירות הרשאה וניהול צוות — בלי גישה למועמדים',
};

export default function StaffManagement() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'content_manager' });
  const [busy, setBusy] = useState(false);

  const load = () => api('/admin/staff').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try { await fn(); await load(); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const email = form.email.trim();
    if (!email) return;
    act(async () => {
      const r = await api('/admin/staff', { method: 'POST', body: JSON.stringify({ ...form, email }) });
      if (r.created) {
        window.alert(r.emailSent
          ? `נשלח ל-${email} מייל שמסביר איך להיכנס ("המשך עם Google").`
          : `החשבון נוצר. שליחת מיילים כבויה כרגע, לכן אמרו ל-${email} להיכנס ב"התחברות" ← "המשך עם Google" עם חשבון ה-Google של המייל הזה.`);
      } else if (r.changed) {
        window.alert(`לחשבון הקיים ${email} ניתן התפקיד ${ROLE_LABELS[form.role]}. החיבורים שלו נסגרו.`);
      }
      setForm({ email: '', firstName: '', lastName: '', role: form.role });
    }, `לתת ל-${email} את התפקיד "${ROLE_LABELS[form.role]}"?`);
  };

  if (error && !data) return <div dir="rtl" className="p-4">{error}</div>;
  if (!data) return <div dir="rtl" className="p-4">טוען…</div>;
  const activeAdmins = data.staff.filter((s) => s.role === 'admin' && s.active).length;

  return (
    <div dir="rtl" className="p-4" style={{ maxWidth: 1200, margin: '0 auto' }}>
      <h2 className="font-RubikMedium">צוות והרשאות</h2>
      <p>
        הפרדת תפקידים: <b>מנהל תוכן</b> — {ROLE_DUTIES.content_manager}. <b>מנהל מערכת</b> — {ROLE_DUTIES.admin}.
        כל שינוי כאן נרשם ביומן הפעילות ונכנס לתוקף מיד (החיבורים של מי ששונה נסגרים).
        אי אפשר להוריד או להשבית את מנהל המערכת הפעיל האחרון.
      </p>

      <h4 className="mt-4">הוספת איש צוות</h4>
      <p>אם כבר יש חשבון עם המייל הזה, הוא מקבל את התפקיד. אחרת נוצר חשבון חדש. אנשי צוות נכנסים רק ב"המשך עם Google" (xhostd SSO) עם חשבון ה-Google של המייל הזה — לחשבון צוות אין סיסמה, וכניסה בסיסמה נחסמת.</p>
      <form className="d-flex gap-2 flex-wrap mb-3" onSubmit={add}>
        <input className="form-control" style={{ maxWidth: 260 }} type="email" required placeholder="אימייל" aria-label="אימייל"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className="form-control" style={{ maxWidth: 160 }} placeholder="שם פרטי (לחשבון חדש)" aria-label="שם פרטי"
          value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        <input className="form-control" style={{ maxWidth: 160 }} placeholder="שם משפחה (לחשבון חדש)" aria-label="שם משפחה"
          value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        <select className="form-select" style={{ maxWidth: 180 }} aria-label="תפקיד" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="content_manager">{ROLE_LABELS.content_manager}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </select>
        <button className="btn btn-dark" type="submit" disabled={busy}>הוספה</button>
      </form>

      <h4 className="mt-4">אנשי צוות ({data.staff.length})</h4>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={cell}>אימייל</th><th style={cell}>שם</th><th style={cell}>תפקיד</th><th style={cell}>מצב</th>
            <th style={cell}>כניסה אחרונה</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {data.staff.map((s) => {
              const isMe = s.id === data.me;
              const lastAdmin = s.role === 'admin' && s.active && activeAdmins <= 1;
              return (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                  <td style={{ ...cell, direction: 'ltr' }}>{s.email}{isMe ? ' (את/ה)' : ''}</td>
                  <td style={cell}>{[s.firstName, s.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td style={cell}>
                    <select className="form-select form-select-sm" aria-label={`תפקיד של ${s.email}`} value={s.role} disabled={busy || lastAdmin}
                      title={lastAdmin ? 'מנהל המערכת הפעיל האחרון' : undefined}
                      onChange={(e) => {
                        const to = e.target.value;
                        act(() => api(`/admin/staff/${s.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: to }) }),
                          `לשנות את התפקיד של ${s.email} ל"${ROLE_LABELS[to]}"?${to === 'user' ? ' הגישה שלו לניהול תוסר.' : ''} החיבורים שלו ייסגרו.`);
                      }}>
                      {data.roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}{r === 'user' ? ' (הסרת גישה)' : ''}</option>)}
                    </select>
                  </td>
                  <td style={cell}>{s.active ? (s.invitePending ? 'עוד לא נכנס עם Google' : 'פעיל') : 'מושבת'}</td>
                  <td style={cell}>{fmt(s.lastLogin)}</td>
                  <td style={cell}>
                    <button className="btn btn-sm btn-outline-dark ms-2" disabled={busy}
                      onClick={() => act(() => api(`/admin/staff/${s.id}/revoke-sessions`, { method: 'POST' }),
                        `לסגור עכשיו את כל החיבורים של ${s.email}?${isMe ? ' גם את/ה תנותק/י.' : ''}`)}>ניתוק חיבורים</button>
                    {s.active ? (
                      <button className="btn btn-sm btn-outline-danger" disabled={busy || isMe || lastAdmin}
                        title={isMe ? 'אי אפשר להשבית את עצמך' : lastAdmin ? 'מנהל המערכת הפעיל האחרון' : undefined}
                        onClick={() => act(() => api(`/admin/staff/${s.id}/deactivate`, { method: 'POST' }),
                          `להשבית את ${s.email}? לא יוכל להיכנס עד שיופעל מחדש.`)}>השבתה</button>
                    ) : (
                      <button className="btn btn-sm btn-outline-success" disabled={busy}
                        onClick={() => act(() => api(`/admin/staff/${s.id}/activate`, { method: 'POST' }))}>הפעלה מחדש</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3"><small>סקירת ההרשאות התקופתית (כל 60 יום) של כל אנשי הצוות נמצאת במסך האבטחה.</small></p>
    </div>
  );
}
