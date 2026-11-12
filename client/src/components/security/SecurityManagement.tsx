// Admin security screen: open alerts, today's usage per content manager with "grant more",
// access reviews of all staff, and the activity log ("who saw this candidate").
// Admins oversee; they see candidate ids in the log, never candidates' details.
// Server: server/src/controllers/securityController.ts. Every action here is recorded.
import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '../../i18n/General.enums';
import ApiTokens from './ApiTokens';

type Usage = { used: number; allowed: number; granted: number };
type Summary = {
  day: string;
  limits: { cvs: { daily: number; alertAt: number; grant: number }; people: { daily: number; alertAt: number; grant: number } };
  alerts: { id: number; kind: string; user_email: string; day: string; threshold: number; created_at: string }[];
  usage: { actor: string; cvs: Usage; people: Usage }[];
  deniedToday: number;
  auditFailures: { count: number; last: string | null; lastAction: string };
  review: { validDays: number; remindDays: number };
  staff: { id: string; email: string; role: string; state: string; review: { by: string; at: string; validUntil: string } | null }[];
  reviewsDue: number;
};
type Entry = { id: number; at: string; actor: string; action: string; target: string | null; details: any };

const ALERT_LABELS: Record<string, string> = {
  cvs_many: 'פתח הרבה קורות חיים היום',
  cvs_limit: 'הגיע למגבלת קורות החיים ומבקש עוד',
  people_many: 'צפה בהרבה מועמדים היום',
  people_limit: 'הגיע למגבלת המועמדים ומבקש עוד',
};
const REVIEW_LABELS: Record<string, string> = {
  never: 'לא נסקר מעולם', valid: 'מאושר', due_soon: 'פג בקרוב', expired: 'פג תוקף', changed: 'ההרשאה השתנתה מאז הסקירה',
};
const ACTION_LABELS: Record<string, string> = {
  'candidates.shown': 'צפה ברשימת מועמדים',
  'candidate.cv_opened': 'פתח קורות חיים',
  'candidate.applications_viewed': 'צפה בהגשות של מועמד',
  'candidate.cv_deleted': 'מחק קורות חיים',
  'user.updated': 'עדכן פרטי מועמד',
  'user.profile_updated': 'מועמד עדכן את הפרטים שלו',
  'staff.invited': 'הוזמן איש צוות',
  'staff.role_changed': 'שונה תפקיד',
  'staff.deactivated': 'הושבת איש צוות',
  'staff.reactivated': 'הופעל מחדש איש צוות',
  'staff.sessions_revoked': 'נותקו החיבורים',
  'staff.roles_split': 'הפרדת תפקידים (מעבר חד-פעמי)',
  'user.signed_up': 'נרשם לאתר',
  'job.applied': 'הגיש מועמדות',
  'guest.applied': 'הגשה כאורח',
  'job.created': 'יצר משרה',
  'job.updated': 'עדכן משרה',
  'job.pinned': 'הקפיץ משרה לראש הלוח',
  'job.unpinned': 'ביטל הקפצת משרה',
  'job.board_updated': 'שינה הגדרות משרה בלוח (פרטית/ציבורית, כתר, תאריך פרסום, סטטוס, הגשה)',
  'job.archived': 'מחק משרה (לארכיון)',
  'job.restored': 'שחזר משרה מהארכיון',
  'jobs.internal_listed': 'צפה ברשימת המשרות לניהול',
  'settings.apply_policy_updated': 'שינה הגדרות הגשה',
  'jobs.submitted': 'מעסיק שלח משרה בטופס',
  'jobs.submission_dropped': 'שליחת משרה נחסמה (מלכודת בוטים / תור מלא)',
  'jobs.submissions_listed': 'צפה ברשימת המשרות ממעסיקים',
  'jobs.submission_viewed': 'פתח משרה ממעסיק (פרטי איש קשר)',
  'jobs.submission_edited': 'ערך משרה ממעסיק',
  'jobs.submission_approved': 'אישר ופרסם משרה ממעסיק',
  'jobs.submission_rejected': 'דחה משרה ממעסיק',
  'auth.login': 'נכנס',
  'auth.login_failed': 'כניסה נכשלה',
  'auth.login_refused_staff_password': 'כניסת צוות בסיסמה נחסמה (צוות נכנס רק ב"המשך עם Google")',
  'auth.oauth_failed': 'כניסה חיצונית נכשלה',
  'auth.sso_linked': 'חשבון Google (xhostd SSO) קושר לחשבון קיים',
  'auth.signup_sso': 'נרשם עם Google (xhostd SSO)',
  'auth.password_reset_refused_staff': 'איפוס סיסמה לחשבון צוות נחסם',
  'auth.logout': 'יצא',
  'auth.password_reset_requested': 'ביקש איפוס סיסמה',
  'auth.password_reset': 'איפס סיסמה',
  'access.denied': 'גישה נדחתה',
  'limits.refused': 'נחסם במגבלה היומית',
  'security.alert_raised': 'התראה נפתחה',
  'security.alert_handled': 'התראה טופלה',
  'security.quota_granted': 'אושרה תוספת',
  'security.access_reviewed': 'הרשאה נסקרה',
  'security.admin_revoked': 'הוסרה הרשאת צוות',
  'audit.searched': 'חיפש ביומן',
  'data.exported': 'ייצוא נתונים לסנדבוקס',
  'sandbox.refreshed': 'רענון סנדבוקס',
  'api_token.created': 'יצר מפתח API פנימי',
  'api_token.revoked': 'ביטל מפתח API פנימי',
  'salesforce.pushed': 'דחף נתונים ל-Salesforce',
};

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
const cell: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid #ddd', textAlign: 'right', verticalAlign: 'top' };

export default function SecurityManagement() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextId, setNextId] = useState<number | null>(null);
  const [search, setSearch] = useState({ subject: '', actor: '', action: '' });

  const load = () => api('/admin/security').then(setData).catch((e) => setError(e.message));
  const searchLog = async (before?: number) => {
    const q = new URLSearchParams();
    if (search.subject) q.set('subject', search.subject);
    if (search.actor) q.set('actor', search.actor);
    if (search.action) q.set('action', search.action);
    if (before) q.set('before', String(before));
    try {
      const r = await api(`/admin/audit?${q}`);
      setEntries((prev) => (before ? [...prev, ...r.entries] : r.entries));
      setNextId(r.next);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { load(); searchLog(); }, []);

  const act = async (path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try { await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); await load(); }
    catch (e) { window.alert((e as Error).message); }
  };

  if (error && !data) return <div dir="rtl" className="p-4">{error}</div>;
  if (!data) return <div dir="rtl" className="p-4">טוען…</div>;
  const L = data.limits;

  return (
    <div dir="rtl" className="p-4" style={{ maxWidth: 1200, margin: '0 auto' }}>
      <h2 className="font-RubikMedium">אבטחה ושימוש חריג</h2>
      <p>
        מגבלות יומיות לכל מנהל תוכן (רק הם רואים מועמדים): עד {L.cvs.daily} קורות חיים (התראה ב-{L.cvs.alertAt}) ועד {L.people.daily} מועמדים שהוצגו
        (כל מועמד נספר פעם ביום, התראה ב-{L.people.alertAt}). כל אישור תוספת מוסיף {L.cvs.grant} קורות חיים
        או {L.people.grant} מועמדים להיום, ונרשם ביומן.
      </p>
      {data.auditFailures.count > 0 && (
        <p style={{ color: '#b00020' }}>
          כתיבה ליומן הפעילות נכשלה {data.auditFailures.count} פעמים מאז ההפעלה האחרונה (אחרונה: {fmt(data.auditFailures.last)}, {data.auditFailures.lastAction}).
        </p>
      )}
      <p>ניסיונות גישה שנדחו היום: {data.deniedToday}</p>

      <h4 className="mt-4">התראות פתוחות ({data.alerts.length})</h4>
      {data.alerts.length === 0 ? <p>אין.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
          {data.alerts.map((a) => {
            const budget = a.kind.startsWith('cvs') ? 'cvs' : 'people';
            return (
              <tr key={a.id}>
                <td style={cell}>{a.user_email}</td>
                <td style={cell}>{ALERT_LABELS[a.kind] ?? a.kind} (סף {a.threshold})</td>
                <td style={cell}>{fmt(a.created_at)}</td>
                <td style={cell}>
                  {a.kind.endsWith('_limit') && (
                    <button className="btn btn-sm btn-dark ms-2" onClick={() => act('/admin/security/grant', { email: a.user_email, budget },
                      `לאשר ל-${a.user_email} עוד ${L[budget].grant} ${budget === 'cvs' ? 'קורות חיים' : 'מועמדים'} להיום?`)}>
                      אשר עוד {L[budget].grant} היום
                    </button>
                  )}
                  <button className="btn btn-sm btn-outline-dark" onClick={() => act(`/admin/security/alerts/${a.id}/handle`)}>סמן כטופל</button>
                </td>
              </tr>
            );
          })}
        </tbody></table>
      )}

      <h4 className="mt-4">שימוש היום ({data.day})</h4>
      {data.usage.length === 0 ? <p>אף מנהל תוכן עוד לא צפה במועמדים היום.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={cell}>מי</th><th style={cell}>קורות חיים</th><th style={cell}>מועמדים שהוצגו</th><th style={cell}></th></tr></thead>
          <tbody>
            {data.usage.map((u) => (
              <tr key={u.actor}>
                <td style={cell}>{u.actor}</td>
                <td style={cell}>{u.cvs.used} / {u.cvs.allowed}</td>
                <td style={cell}>{u.people.used} / {u.people.allowed}</td>
                <td style={cell}>
                  <button className="btn btn-sm btn-outline-dark ms-2" onClick={() => act('/admin/security/grant', { email: u.actor, budget: 'cvs' }, `לאשר ל-${u.actor} עוד ${L.cvs.grant} קורות חיים היום?`)}>+{L.cvs.grant} קו״ח</button>
                  <button className="btn btn-sm btn-outline-dark" onClick={() => act('/admin/security/grant', { email: u.actor, budget: 'people' }, `לאשר ל-${u.actor} עוד ${L.people.grant} מועמדים היום?`)}>+{L.people.grant} מועמדים</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 className="mt-4">אנשי צוות וסקירת הרשאות</h4>
      <p>כל {data.review.validDays} יום מאשרים, איש צוות אחר איש צוות (מנהלי תוכן ומנהלי מערכת), שעדיין צריך גישה. שום הרשאה לא מוסרת אוטומטית. הוספה, שינוי תפקיד והשבתה — במסך "צוות והרשאות".</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>
        {data.staff.map((a) => (
          <tr key={a.id}>
            <td style={cell}>{a.email}</td>
            <td style={cell}>{ROLE_LABELS[a.role] ?? a.role}</td>
            <td style={{ ...cell, color: a.state === 'valid' ? 'inherit' : '#b00020' }}>{REVIEW_LABELS[a.state] ?? a.state}</td>
            <td style={cell}>{a.review ? `אושר ע״י ${a.review.by} ב-${fmt(a.review.at)}, בתוקף עד ${fmt(a.review.validUntil)}` : '—'}</td>
            <td style={cell}>
              <button className="btn btn-sm btn-dark ms-2" onClick={() => act(`/admin/security/reviews/${a.id}`, {}, `לאשר ש-${a.email} עדיין צריך הרשאת ${ROLE_LABELS[a.role] ?? a.role}?`)}>עדיין צריך גישה</button>
              <button className="btn btn-sm btn-outline-danger" onClick={() => act(`/admin/security/admins/${a.id}/revoke`, {}, `להסיר את ההרשאה של ${a.email} (${ROLE_LABELS[a.role] ?? a.role})? הוא יתנתק מיד.`)}>הסר הרשאה</button>
            </td>
          </tr>
        ))}
      </tbody></table>

      <ApiTokens />

      <h4 className="mt-4">יומן פעילות</h4>
      <p>חיפוש לפי מועמד (מזהה או אימייל) מראה מי צפה בו, פתח את קורות החיים שלו או שינה את פרטיו.</p>
      <form className="d-flex gap-2 flex-wrap mb-2" onSubmit={(e) => { e.preventDefault(); searchLog(); }}>
        <input className="form-control" style={{ maxWidth: 260 }} placeholder="מועמד: מזהה או אימייל" value={search.subject} onChange={(e) => setSearch({ ...search, subject: e.target.value })} />
        <input className="form-control" style={{ maxWidth: 220 }} placeholder="מי: אימייל איש צוות" value={search.actor} onChange={(e) => setSearch({ ...search, actor: e.target.value })} />
        <input className="form-control" style={{ maxWidth: 220 }} placeholder="פעולה, למשל candidate." value={search.action} onChange={(e) => setSearch({ ...search, action: e.target.value })} />
        <button className="btn btn-dark" type="submit">חיפוש</button>
      </form>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead><tr><th style={cell}>מתי</th><th style={cell}>מי</th><th style={cell}>פעולה</th><th style={cell}>על מה</th><th style={cell}>פרטים</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td style={cell}>{fmt(e.at)}</td>
              <td style={cell}>{e.actor}</td>
              <td style={cell}>{ACTION_LABELS[e.action] ?? e.action}</td>
              <td style={{ ...cell, direction: 'ltr' }}>{e.target ?? ''}</td>
              <td style={{ ...cell, direction: 'ltr', maxWidth: 380, overflowWrap: 'anywhere' }}>{e.details ? JSON.stringify(e.details) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nextId && <button className="btn btn-outline-dark mt-2" onClick={() => searchLog(nextId)}>עוד</button>}
    </div>
  );
}
