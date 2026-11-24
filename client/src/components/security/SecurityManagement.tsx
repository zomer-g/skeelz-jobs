// Admin security screen, built to be scanned: summary tiles on top (open alerts, refused today, reviews due,
// active API keys), then short sections — alerts, today's usage per person (bars), access reviews, API keys,
// the activity log. Long explanations sit in "מה זה?" disclosures.
// Server: server/src/controllers/securityController.ts. Every action here is recorded.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ROLE_LABELS } from '../../i18n/General.enums';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import ApiTokens, { countActiveTokens } from './ApiTokens';
import SalesforceSync from './SalesforceSync';
import PersonActivity, { isAccountActor } from './PersonActivity';
import { Chip, Help, Meter, Tone, api, fmtDate, fmtDateTime, relTime } from './ui';

type Usage = { used: number; allowed: number; granted: number };
type Summary = {
  day: string;
  limits: Record<'cvs' | 'people' | 'employerCvs' | 'employerPeople', { daily: number; alertAt: number; grant: number }>;
  alerts: { id: number; kind: string; user_email: string; day: string; threshold: number; created_at: string; details?: any }[];
  usage: { actor: string; cvs: Usage; people: Usage }[];
  /** Employers who saw forwarded applicants today (their own budgets; never raised). */
  employerUsage?: { actor: string; cvs: Usage; people: Usage }[];
  deniedToday: number;
  auditFailures: { count: number; last: string | null; lastAction: string };
  review: { validDays: number; remindDays: number };
  staff: { id: string; email: string; role: string; state: string; review: { by: string; at: string; validUntil: string } | null }[];
  reviewsDue: number;
};
type Entry = { id: number; at: string; actor: string; action: string; target: string | null; details: any };

const ALERT_LABELS: Record<string, string> = {
  cvs_many: 'פתח/ה הרבה קורות חיים היום',
  cvs_limit: 'הגיע/ה למגבלת קורות החיים',
  people_many: 'צפה/תה בהרבה מועמדים היום',
  people_limit: 'הגיע/ה למגבלת המועמדים',
  employerCvs_many: 'מעסיק פתח הרבה קורות חיים של מועמדים שהועברו אליו היום',
  employerCvs_limit: 'מעסיק הגיע למגבלת קורות החיים שלו',
  employerPeople_many: 'מעסיק צפה בהרבה מועמדים שהועברו אליו היום',
  employerPeople_limit: 'מעסיק הגיע למגבלת המועמדים שלו',
  // Unusual sign-ins (server/src/security/signins.ts; thresholds SIGNIN_ALERTS in pure.ts).
  signin_failures_staff: 'הרבה ניסיונות כניסה שנכשלו או נחסמו לחשבון צוות',
  signin_new_address: 'איש צוות נכנס מכתובת שלא נכנס ממנה קודם',
  signin_many_accounts: 'הרבה חשבונות שונים נכנסו מאותה כתובת',
};
/** Access review state → chip. */
const REVIEW_CHIP: Record<string, { label: string; tone: Tone }> = {
  valid: { label: 'מאושר', tone: 'ok' },
  due_soon: { label: 'פג בקרוב', tone: 'warn' },
  never: { label: 'ממתין', tone: 'warn' },
  changed: { label: 'ממתין (התפקיד השתנה)', tone: 'warn' },
  expired: { label: 'פג תוקף', tone: 'alert' },
};
const ACTION_LABELS: Record<string, string> = {
  'candidates.shown': 'צפה ברשימת מועמדים',
  'candidate.cv_opened': 'פתח קורות חיים',
  'candidate.applications_viewed': 'צפה בהגשות של מועמד',
  'candidate.cv_deleted': 'מחק קורות חיים (פעולה ישנה)',
  'candidate.cv_unlinked': 'הסיר קורות חיים מפרופיל של מועמד (הקובץ נשמר)',
  'user.updated': 'עדכן פרטי מועמד',
  'user.profile_updated': 'מועמד עדכן את הפרטים שלו',
  'user.marketing_consent_changed': 'מועמד שינה הסכמה לדיוור',
  'user.terms_accepted': 'מועמד אישר את תנאי השימוש בכניסה',
  'staff.invited': 'הוזמן איש צוות',
  'staff.role_changed': 'שונה תפקיד',
  'staff.deactivated': 'הושבת איש צוות',
  'staff.reactivated': 'הופעל מחדש איש צוות',
  'staff.sessions_revoked': 'נותקו החיבורים',
  'users.role_blocked': 'חסם תפקיד בחשבון',
  'users.role_unblocked': 'ביטל חסימת תפקיד בחשבון',
  'users.role_blocks_viewed': 'צפה בחסימות התפקידים של חשבון',
  'mail.address_keys_moved': 'רשימות ההסרה והחסימה עברו למפתח הייעודי',
  'staff.roles_split': 'הפרדת תפקידים (מעבר חד-פעמי)',
  'user.signed_up': 'נרשם לאתר',
  'cv.uploaded': 'העלה קובץ קורות חיים',
  'cv.attached': 'קורות חיים צורפו (הרשמה, אזור אישי, הגשה או הגשה כאורח)',
  'job.applied': 'הגיש מועמדות',
  'guest.applied': 'הגשה כאורח',
  'job.created': 'יצר משרה',
  'job.updated': 'עדכן משרה',
  'job.pinned': 'נעץ משרה בראש הלוח',
  'job.unpinned': 'ביטל נעיצת משרה',
  'job.bumped': 'הקפיץ משרה לראש הרשימה',
  'job.board_updated': 'שינה הגדרות משרה בלוח (ממומנת, תאריך פרסום, סטטוס, הגשה)',
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
  'settings.employer_posting_updated': 'שינה את הגדרת פרסום המשרות למעסיקים',
  'settings.signup_fields_updated': 'שינה את שדות החובה בטופס ההרשמה',
  'settings.custom_field_created': 'הוסיף שדה לטופס (הרשמה או משרה)',
  'settings.custom_field_updated': 'שינה שדה שנוסף לטופס (הרשמה או משרה)',
  'settings.custom_field_approved': 'אישר והפעיל שאלה בטופס ההרשמה',
  'salesforce.custom_field_linked': 'קישר שדה שנוסף בהגדרות לשדה ב-Salesforce (או הסיר קישור)',
  'auth.signup_employer': 'נרשם כמעסיק',
  'auth.role_added': 'הוסיף לעצמו תפקיד (מועמד / מעסיק)',
  'employer.profile_updated': 'מעסיק עדכן את פרטיו',
  'employer.submissions_claimed': 'מעסיק צירף לחשבון משרות ששלח בעבר',
  'jobs.edit_requested': 'מעסיק ביקש לערוך משרה',
  'jobs.edit_withdrawn': 'מעסיק ביטל בקשת עריכה',
  'jobs.edit_requests_listed': 'צפה ברשימת בקשות עריכה של מעסיקים',
  'jobs.edit_request_viewed': 'פתח בקשת עריכה של מעסיק',
  'jobs.edit_request_approved': 'אישר בקשת עריכה של מעסיק',
  'jobs.edit_request_rejected': 'דחה בקשת עריכה של מעסיק',
  // Applicants forwarded to employers (docs/employers.md "Applicants"). "Who saw X" finds the employer's views too.
  'employer.applicant_forwarded': 'העביר מועמדות למעסיק',
  'employer.forward_cancelled': 'ביטל העברת מועמדות למעסיק',
  'employer.forward_cancel_refused': 'ביטול העברה נדחה: המעסיק כבר צפה במועמדות',
  'employer.applicants_shown': 'מעסיק צפה במועמדים שהועברו אליו',
  'employer.cv_opened': 'מעסיק פתח קורות חיים של מועמד שהועבר אליו',
  'auth.login': 'נכנס (עם כתובת ומכשיר)',
  'auth.login_refused_deactivated': 'כניסה נחסמה: החשבון מושבת',
  'auth.login_refused_blocked': 'כניסה נחסמה: התפקידים חסומים',
  'auth.login_failed': 'כניסה בסיסמה נכשלה (עד 11.2026)',
  'auth.login_refused_staff_password': 'כניסת צוות בסיסמה נחסמה (צוות נכנס רק ב"המשך עם Google")',
  'auth.oauth_failed': 'כניסה חיצונית נכשלה',
  'auth.sso_linked': 'חשבון Google (xhostd SSO) או Microsoft קושר לחשבון קיים',
  'auth.sso_password_cleared': 'הסיסמה של חשבון קיים בוטלה וחיבוריו נסגרו כשקושר ל-Google או ל-Microsoft',
  'auth.signup_sso': 'נרשם עם Google (xhostd SSO) או Microsoft',
  'auth.password_reset_refused_staff': 'איפוס סיסמה לחשבון צוות נחסם',
  'auth.logout': 'יצא',
  'auth.password_reset_requested': 'ביקש איפוס סיסמה (עד 11.2026)',
  'auth.password_reset': 'איפס סיסמה (עד 11.2026)',
  // "קבלת קוד למייל" (server/src/controllers/emailSigninController.ts). Never the code or the address.
  'auth.email_code_requested': 'ביקש קוד כניסה למייל',
  'auth.email_code_limited': 'בקשת קוד למייל נחסמה (יותר מדי בקשות לאותה כתובת)',
  'auth.email_code_refused_staff': 'קוד למייל לא נשלח: חשבון צוות (צוות נכנס רק ב"המשך עם Google")',
  'auth.email_code_refused_deactivated': 'קוד למייל לא נשלח: החשבון מושבת',
  'auth.email_code_refused_blocked': 'קוד למייל לא נשלח: התפקידים חסומים',
  'auth.email_code_send_failed': 'שליחת קוד הכניסה במייל נכשלה',
  'mail.template_saved': 'שמר גרסה של תבנית מייל',
  'mail.template_published': 'פרסם תבנית מייל (מעכשיו היא נשלחת)',
  'mail.template_reset': 'החזיר תבנית מייל לנוסח המקורי',
  'mail.event_enabled': 'הפעיל מייל אוטומטי',
  'mail.event_disabled': 'כיבה מייל אוטומטי',
  'mail.test_sent': 'שלח לעצמו מייל בדיקה',
  'mail.suppression_removed': 'שחרר כתובת חסומה לשליחת מיילים',
  'mail.suppressed': 'כתובת נחסמה לשליחה (מייל חזר או סומן כספאם)',
  'marketing.removed_by_staff': 'רשם בקשת הסרה מדיוור שיווקי (לבקשת האדם)',
  'marketing.unsubscribed': 'הסרה מדיוור שיווקי בקישור שבמייל',
  'marketing.complaint': 'הוסר מדיוור שיווקי: סימן מייל כספאם',
  'auth.email_code_failed': 'קוד כניסה שגוי, שפג תוקפו או שנחסם',
  'auth.email_code_verified': 'אימת מייל חדש בקוד (טופס הרשמה)',
  'auth.email_code_signup': 'נרשם עם קוד למייל',
  'auth.candidate_passwords_cleared': 'סיסמאות המועמדים נמחקו (מעבר לכניסה בקוד למייל)',
  'jobs.imported_purged': 'המשרות שהועתקו מהאתר הקיים נמחקו, עם ההגשות אליהן',
  'jobs.test_jobs_purged': 'שתי משרות הבדיקה נמחקו (לפני החיבור ל-Salesforce)',
  'users.candidates_purged': 'חשבונות המועמדים נמחקו מהאתר, עם ההגשות וקורות החיים (לפני החיבור ל-Salesforce)',
  'access.denied': 'גישה נדחתה',
  'limits.refused': 'נחסם במגבלה היומית',
  'security.alert_raised': 'התראה נפתחה',
  'security.alert_handled': 'התראה טופלה',
  'security.quota_granted': 'אושרה תוספת',
  'security.access_reviewed': 'הרשאה נסקרה',
  'security.admin_revoked': 'הוסרה הרשאת צוות',
  'audit.searched': 'חיפש ביומן',
  'audit.person_viewed': 'פתח את הפעילות של חשבון',
  'data.exported': 'ייצוא נתונים לסנדבוקס',
  'sandbox.refreshed': 'רענון סנדבוקס',
  'api_token.created': 'יצר מפתח API פנימי',
  'api_token.revoked': 'ביטל מפתח API פנימי',
  'salesforce.pushed': 'דחף נתונים ל-Salesforce',
  'salesforce.checked': 'בדק את החיבור ל-Salesforce (קריאה בלבד)',
  'salesforce.retried': 'החזיר לתור רשומות שנכשלו בשליחה ל-Salesforce',
  'legacy_candidates.mirrored': 'מועמדי האתר הקיים נקראו מ-Salesforce',
  'legacy_candidates.taken_over': 'מועמדי האתר הקיים עברו לניהול כאן',
  'legacy_candidates.returned_to_mirror': 'מועמדי האתר הקיים חזרו לצפייה בלבד',
  'salesforce.cutover_report': 'הפיק דוח התאמה למעבר מהאתר הקיים (קריאה בלבד מ-Salesforce)',
  'legacy_jobs.mirrored': 'קרא את משרות האתר הקיים מ-Salesforce (קריאה בלבד)',
  'legacy_jobs.taken_over': 'המעבר: משרות האתר הקיים עברו לניהול באתר הזה',
  'legacy_jobs.returned_to_mirror': 'חזרה לאחור: משרות האתר הקיים חזרו להתעדכן מ-Salesforce',
};

/** Action groups for the log filter (prefix match on the server). */
const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: '', label: 'כל הפעולות' },
  { value: 'candidate', label: 'מועמדים וקורות חיים' },
  { value: 'cv.', label: 'העלאות קורות חיים' },
  { value: 'job', label: 'משרות' },
  { value: 'auth.', label: 'כניסות ויציאות' },
  { value: 'staff.', label: 'צוות והרשאות' },
  { value: 'security.', label: 'אבטחה' },
  { value: 'api_token.', label: 'מפתחות API' },
  { value: 'employer.', label: 'מעסיקים' },
  { value: 'salesforce.', label: 'Salesforce' },
  { value: 'access.denied', label: 'גישה שנדחתה' },
];

const Tile: React.FC<{ n: number; label: string; tone: 'ok' | 'warn' | 'alert'; href: string; hint?: string }> = ({ n, label, tone, href, hint }) => (
  <li>
    <a className={`sec-tile sec-tile--${tone}`} href={href} onClick={(e) => { e.preventDefault(); document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' }); (document.querySelector(href) as HTMLElement | null)?.focus(); }}>
      <span className="sec-tile__num">{n}</span>
      <span className="sec-tile__label">{label}</span>
      {hint && <span className="sec-tile__hint">{hint}</span>}
      {tone !== 'ok' && <span className="visually-hidden"> — דורש טיפול</span>}
    </a>
  </li>
);

export default function SecurityManagement() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Whose activity is open (?person=<user id | user:<id> | staff email>), so the staff screen can link here.
  const person = params.get('person');
  const openPerson = (who: string | null) => {
    const next = new URLSearchParams(params);
    if (who) next.set('person', who); else next.delete('person');
    setParams(next, { replace: !who });
  };
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextId, setNextId] = useState<number | null>(null);
  const [search, setSearch] = useState({ subject: '', actor: '', action: '' });
  const [activeKeys, setActiveKeys] = useState<number | null>(null);
  const [logBusy, setLogBusy] = useState(false);

  const load = () => api('/admin/security').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  const searchLog = async (before?: number) => {
    const q = new URLSearchParams();
    if (search.subject.trim()) q.set('subject', search.subject.trim());
    if (search.actor.trim()) q.set('actor', search.actor.trim());
    if (search.action) q.set('action', search.action);
    if (before) q.set('before', String(before));
    setLogBusy(true);
    try {
      const r = await api(`/admin/audit?${q}`);
      setEntries((prev) => (before ? [...prev, ...r.entries] : r.entries));
      setNextId(r.next);
    } catch (e) { setError((e as Error).message); }
    finally { setLogBusy(false); }
  };
  useEffect(() => {
    load(); searchLog();
    api('/admin/api-tokens').then((d) => setActiveKeys(countActiveTokens(d.tokens))).catch(() => setActiveKeys(null));
  }, []);

  const act = async (path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try { await api(path, { method: 'POST', body: JSON.stringify(body ?? {}) }); await load(); }
    catch (e) { window.alert((e as Error).message); }
  };

  if (error && !data) return <div dir="rtl" className="board-frame sec-page"><p role="alert">{error}</p></div>;
  if (!data) return <div dir="rtl" className="board-frame sec-page"><p aria-busy="true">טוען…</p></div>;
  const L = data.limits;
  // An alert is about a person (staff email / user:<id>) or, for many accounts from one place, an address.
  const nameOf = (who: string) => (who.startsWith('address:') ? `הכתובת ${who.slice(8)}:` : who);

  return (
    <div dir="rtl" className="board-frame sec-page">
      <div className="sec-page__head">
        <div>
          <h1 className="font-EzerRegularLoft display-6">אבטחה</h1>
          <p className="sec-page__sub">מצב היום ({fmtDate(data.day)}) — מה דורש טיפול.</p>
        </div>
        <button type="button" className="board-pill" onClick={() => navigate(ClientRoutes.StaffManagement)}>
          <i className="bi bi-people" aria-hidden="true" /> צוות והרשאות
        </button>
      </div>

      <ul className="sec-tiles" aria-label="סיכום">
        <Tile n={data.alerts.length} label="התראות פתוחות" tone={data.alerts.length ? 'alert' : 'ok'} href="#sec-alerts-h" />
        <Tile n={data.deniedToday} label="גישות שנדחו היום" tone={data.deniedToday >= 20 ? 'warn' : 'ok'} href="#sec-log-h" />
        <Tile n={data.reviewsDue} label="ממתינים לסקירת הרשאות" tone={data.staff.some((s) => s.state === 'expired') ? 'alert' : data.reviewsDue ? 'warn' : 'ok'} href="#sec-reviews-h" />
        <Tile n={activeKeys ?? 0} label="מפתחות API פעילים" tone="ok" href="#api-tokens" />
      </ul>

      {data.auditFailures.count > 0 && (
        <p className="sec-note sec-note--alert" role="alert">
          <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" /> כתיבה ליומן הפעילות נכשלה {data.auditFailures.count} פעמים מאז ההפעלה
          (אחרונה {relTime(data.auditFailures.last)}, {ACTION_LABELS[data.auditFailures.lastAction] ?? data.auditFailures.lastAction}).
        </p>
      )}

      <section className="sec-card" aria-labelledby="sec-alerts-h">
        <div className="sec-card__head"><h2 id="sec-alerts-h" tabIndex={-1}>התראות</h2></div>
        {data.alerts.length === 0 ? <p className="sec-empty"><Chip tone="ok">אין התראות פתוחות</Chip></p> : (
          <ul className="sec-alerts">
            {data.alerts.map((a) => {
              const budget = a.kind.startsWith('cvs') ? 'cvs' : 'people';
              // An employer's limit is never raised: no grant button for their alerts.
              const grantable = a.kind === 'cvs_limit' || a.kind === 'people_limit';
              return (
                <li key={a.id} className="sec-alert">
                  <div>
                    <div className="sec-alert__what"><i className="bi bi-exclamation-octagon" aria-hidden="true" /> {nameOf(a.user_email)} {ALERT_LABELS[a.kind] ?? a.kind}</div>
                    <div className="sec-muted">
                      {a.kind.startsWith('signin_') ? <>
                        {a.details?.ip && <>כתובת <span className="sec-ltr">{a.details.ip}</span> · </>}
                        {a.details?.device && <><span className="sec-ltr">{a.details.device}</span> · </>}
                        {a.details?.failures ? <>{a.details.failures} ניסיונות · </> : null}
                        {a.details?.accounts ? <>{a.details.accounts} חשבונות · </> : null}
                      </> : <>סף {a.threshold} · </>}
                      {relTime(a.created_at)}
                    </div>
                  </div>
                  <div className="sec-actions">
                    {grantable && (
                      <button type="button" className="sec-btn sec-btn--primary" onClick={() => act('/admin/security/grant', { email: a.user_email, budget },
                        `לאשר ל-${a.user_email} עוד ${L[budget].grant} ${budget === 'cvs' ? 'קורות חיים' : 'מועמדים'} להיום?`)}>
                        אישור עוד {L[budget].grant} להיום
                      </button>
                    )}
                    {isAccountActor(a.user_email) && (
                      <button type="button" className="sec-btn" onClick={() => openPerson(a.user_email)}>הפעילות שלו</button>
                    )}
                    <button type="button" className="sec-btn" onClick={() => act(`/admin/security/alerts/${a.id}/handle`)}>סימון כטופל</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="sec-card" aria-labelledby="sec-usage-h">
        <div className="sec-card__head"><h2 id="sec-usage-h">שימוש היום</h2></div>
        <p className="sec-card__hint">קורות חיים עד {L.cvs.daily} ומועמדים עד {L.people.daily} לאדם ביום.</p>
        <Help>
          <p>כל רכז השמה, מנהל תוכן ומנהל מערכת שצופה במועמדים נספר: כל פתיחת קורות חיים, וכל מועמד שהוצג (פעם אחת ביום לכל מועמד).
            התראה נפתחת ב-{L.cvs.alertAt} קורות חיים או ב-{L.people.alertAt} מועמדים. במגבלה הבקשה נחסמת, ומנהל מערכת יכול לאשר
            עוד {L.cvs.grant} קורות חיים או {L.people.grant} מועמדים להיום. כל אישור נרשם ביומן.</p>
        </Help>
        {data.usage.length === 0 ? <p className="sec-empty">אף אחד עוד לא צפה במועמדים היום.</p> : (
          <table className="sec-table sec-table--stack">
            <thead><tr><th scope="col">מי</th><th scope="col">קורות חיים</th><th scope="col">מועמדים</th><th scope="col"><span className="visually-hidden">פעולות</span></th></tr></thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={u.actor}>
                  <td className="sec-cell-main sec-ltr">{u.actor}</td>
                  <td data-label="קורות חיים"><Meter used={u.cvs.used} allowed={u.cvs.allowed} alertAt={L.cvs.alertAt} label={`קורות חיים של ${u.actor}`} /></td>
                  <td data-label="מועמדים"><Meter used={u.people.used} allowed={u.people.allowed} alertAt={L.people.alertAt} label={`מועמדים של ${u.actor}`} /></td>
                  <td><div className="sec-actions">
                    <button type="button" className="sec-btn" aria-label={`אישור עוד ${L.cvs.grant} קורות חיים ל-${u.actor}`}
                      onClick={() => act('/admin/security/grant', { email: u.actor, budget: 'cvs' }, `לאשר ל-${u.actor} עוד ${L.cvs.grant} קורות חיים היום?`)}>+{L.cvs.grant} קו״ח</button>
                    <button type="button" className="sec-btn" aria-label={`אישור עוד ${L.people.grant} מועמדים ל-${u.actor}`}
                      onClick={() => act('/admin/security/grant', { email: u.actor, budget: 'people' }, `לאשר ל-${u.actor} עוד ${L.people.grant} מועמדים היום?`)}>+{L.people.grant} מועמדים</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {!!data.employerUsage?.length && (
        <section className="sec-card" aria-labelledby="sec-emp-usage-h">
          <div className="sec-card__head"><h2 id="sec-emp-usage-h">מעסיקים היום</h2></div>
          <p className="sec-card__hint">מעסיק רואה רק מועמדים שהצוות העביר אליו: עד {L.employerCvs.daily} קורות חיים ועד {L.employerPeople.daily} מועמדים ביום,
            התראה ב-{L.employerCvs.alertAt} / {L.employerPeople.alertAt}. המגבלה של מעסיק לא מוגדלת. מי צפה במי — ביומן, בחיפוש לפי מועמד.</p>
          <table className="sec-table sec-table--stack">
            <thead><tr><th scope="col">מעסיק</th><th scope="col">קורות חיים</th><th scope="col">מועמדים</th></tr></thead>
            <tbody>
              {data.employerUsage.map((u) => (
                <tr key={u.actor}>
                  <td className="sec-cell-main sec-ltr">{u.actor}</td>
                  <td data-label="קורות חיים"><Meter used={u.cvs.used} allowed={u.cvs.allowed} alertAt={L.employerCvs.alertAt} label={`קורות חיים של ${u.actor}`} /></td>
                  <td data-label="מועמדים"><Meter used={u.people.used} allowed={u.people.allowed} alertAt={L.employerPeople.alertAt} label={`מועמדים של ${u.actor}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="sec-card" aria-labelledby="sec-reviews-h">
        <div className="sec-card__head">
          <h2 id="sec-reviews-h" tabIndex={-1}>סקירת הרשאות</h2>
          <span className="sec-muted">כל {data.review.validDays} יום</span>
        </div>
        <Help>
          <p>כל {data.review.validDays} יום מאשרים, לכל איש צוות, שעדיין צריך את הגישה שלו. {data.review.remindDays} ימים לפני שהאישור פג
            מופיעה תזכורת. שינוי תפקיד מחייב אישור מחדש. שום הרשאה לא מוסרת אוטומטית. הוספה, שינוי תפקיד והשבתה — במסך "צוות והרשאות".</p>
        </Help>
        <table className="sec-table sec-table--stack">
          <thead><tr><th scope="col">איש צוות</th><th scope="col">תפקיד</th><th scope="col">סטטוס</th><th scope="col">בתוקף עד</th><th scope="col"><span className="visually-hidden">פעולות</span></th></tr></thead>
          <tbody>
            {data.staff.map((a) => {
              const chip = REVIEW_CHIP[a.state] ?? { label: a.state, tone: 'muted' as Tone };
              return (
                <tr key={a.id}>
                  <td className="sec-cell-main sec-ltr">{a.email}</td>
                  <td data-label="תפקיד">{ROLE_LABELS[a.role] ?? a.role}</td>
                  <td data-label="סטטוס"><Chip tone={chip.tone}>{chip.label}</Chip></td>
                  <td data-label="בתוקף עד">
                    {a.review ? <span title={`אושר ע״י ${a.review.by}, ${fmtDateTime(a.review.at)}`}>{fmtDate(a.review.validUntil)}</span> : '—'}
                  </td>
                  <td><div className="sec-actions">
                    <button type="button" className="sec-btn" aria-label={`הפעילות של ${a.email}`} onClick={() => openPerson(a.id)}>פעילות</button>
                    <button type="button" className={`sec-btn${a.state === 'valid' ? '' : ' sec-btn--primary'}`} aria-label={`אישור שעדיין צריך גישה: ${a.email}`}
                      onClick={() => act(`/admin/security/reviews/${a.id}`, {}, `לאשר ש-${a.email} עדיין צריך הרשאת ${ROLE_LABELS[a.role] ?? a.role}?`)}>עדיין צריך גישה</button>
                    <button type="button" className="sec-btn sec-btn--danger" aria-label={`הסרת ההרשאה של ${a.email}`}
                      onClick={() => act(`/admin/security/admins/${a.id}/revoke`, {}, `להסיר את ההרשאה של ${a.email} (${ROLE_LABELS[a.role] ?? a.role})? החיבורים שלו ייסגרו מיד.`)}>הסרת הרשאה</button>
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <ApiTokens onChange={setActiveKeys} />

      <SalesforceSync />


      {person && <PersonActivity who={person} labels={ACTION_LABELS} onClose={() => openPerson(null)} />}

      <section className="sec-card" aria-labelledby="sec-log-h">
        <div className="sec-card__head"><h2 id="sec-log-h" tabIndex={-1}>יומן פעילות</h2></div>
        <p className="sec-card__hint">מי צפה במי ומה שונה. חיפוש לפי מועמד מראה מי צפה בו. לחיצה על "מי" פותחת את כל הפעילות של החשבון.</p>
        <form className="sec-filters" role="search" aria-label="סינון היומן" onSubmit={(e) => { e.preventDefault(); searchLog(); }}>
          <label>מועמד (מזהה או מייל)
            <input className="form-control" value={search.subject} onChange={(e) => setSearch({ ...search, subject: e.target.value })} dir="ltr" />
          </label>
          <label>מי (מייל של איש צוות)
            <input className="form-control" value={search.actor} onChange={(e) => setSearch({ ...search, actor: e.target.value })} dir="ltr" />
          </label>
          <label>פעולה
            <select className="form-select" value={search.action} onChange={(e) => setSearch({ ...search, action: e.target.value })}>
              {ACTION_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </label>
          <button className="sec-btn sec-btn--primary" type="submit" disabled={logBusy}><i className="bi bi-search" aria-hidden="true" />חיפוש</button>
        </form>
        {entries.length === 0 ? <p className="sec-empty">{logBusy ? 'טוען…' : 'אין רשומות.'}</p> : (
          <ul className="sec-log" aria-live="polite">
            {entries.map((e) => (
              <li key={e.id} className="sec-log__item">
                <time className="sec-log__when" dateTime={e.at} title={fmtDateTime(e.at)}>{relTime(e.at)}</time>
                <div>
                  <div className="sec-log__what">{ACTION_LABELS[e.action] ?? e.action}</div>
                  <div className="sec-log__who">
                    <span className="sec-muted">מי: </span>
                    {isAccountActor(e.actor)
                      ? <button type="button" className="sec-linkbtn sec-ltr" title="כל הפעילות של החשבון" onClick={() => openPerson(e.actor)}>{e.actor}</button>
                      : <span className="sec-ltr">{e.actor}</span>}
                    {e.details?.ip && <><span className="sec-muted"> · כתובת: </span><span className="sec-ltr">{e.details.ip}</span></>}
                    {e.details?.device && <><span className="sec-muted"> · </span><span className="sec-ltr">{e.details.device}</span></>}
                    {e.target ? <><span className="sec-muted"> · על: </span><span className="sec-ltr">{e.target}</span></> : null}
                  </div>
                  {e.details && (
                    <details><summary>פרטים</summary><pre dir="ltr">{JSON.stringify(e.details, null, 1)}</pre></details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextId && <button type="button" className="sec-btn mt-2" disabled={logBusy} onClick={() => searchLog(nextId)}>עוד רשומות</button>}
      </section>
    </div>
  );
}
