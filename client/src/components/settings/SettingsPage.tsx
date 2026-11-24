// The settings screen (/settings, owner 23.11.2026): every setting of the sign-up form, the job form and applying, in
// one place, for every content manager (and admin). Placement coordinators don't open it (client guard + the server's
// contentManagerOnly gates). Security, Salesforce and API keys stay on the admins' security screen.
// Rules: docs/settings.md.
import { useEffect, useState } from 'react';
import { Help, api } from '../security/ui';
import SignupFieldsSettings from './SignupFieldsSettings';
import CustomFieldsEditor from './CustomFieldsEditor';
import ApplyPolicySettings from '../applyPolicy/ApplyPolicySettings';
import EmployerPostingSettings from './EmployerPostingSettings';
import { CustomFieldDef, loadSignupCustomFields } from '../../utils/customFields';
import { SalesforceInfo } from './CustomFieldsEditor';
import useAuthStore from '../../store/Auth.store';
import { userHasRole, UserRole } from '../../i18n/General.enums';

const SECTIONS = [
  { id: 'settings-signup', label: 'טופס הרשמה' },
  { id: 'settings-job', label: 'טופס משרה ופרסום משרות' },
  { id: 'settings-apply', label: 'הגשה למשרות' },
];

export default function SettingsPage() {
  const [fields, setFields] = useState<CustomFieldDef[] | null>(null);
  const [error, setError] = useState('');
  const [salesforce, setSalesforce] = useState<SalesforceInfo | undefined>();
  // Linking a field to Salesforce is the admins' (the Salesforce settings are theirs); content managers see the state.
  const isAdmin = userHasRole(useAuthStore().user, UserRole.ADMIN);

  const load = () => api('/admin/settings/custom-fields')
    .then((d) => { setFields(d.fields); setSalesforce(d.salesforce); setError(''); void loadSignupCustomFields(true); })
    .catch(() => setError('לא הצלחנו לקרוא את השדות שנוספו.'));
  useEffect(() => { void load(); }, []);

  return (
    <div dir="rtl" className="board-frame sec-page settings-page">
      <div className="sec-page__head">
        <div>
          <h1 className="font-EzerRegularLoft display-6">הגדרות</h1>
          <p className="sec-page__sub">טופס ההרשמה, טופס המשרה ופרסום משרות, וההגשה למשרות. כל שינוי נכנס לתוקף מיד ונרשם ביומן הפעילות.</p>
        </div>
      </div>
      <nav aria-label="חלקי ההגדרות" className="settings-page__toc mb-3">
        <ul className="d-flex flex-wrap gap-2 list-unstyled m-0 p-0">
          {SECTIONS.map((s) => <li key={s.id}><a className="board-pill" href={`#${s.id}`}>{s.label}</a></li>)}
        </ul>
      </nav>

      <h2 id="settings-signup" className="font-RubikBold fs-4 mt-2" tabIndex={-1}>טופס הרשמה למועמדים</h2>
      <SignupFieldsSettings />
      {error && <p role="alert" className="sec-note">{error}</p>}
      {fields && (
        <CustomFieldsEditor form="signup" fields={fields} onChanged={load} salesforce={salesforce} isAdmin={isAdmin} title="שאלות נוספות בהרשמה"
          intro="שאלות שתוסיפו כאן מופיעות בטופס ההרשמה ובאזור האישי של המועמד. התשובות מוצגות לצוות ברשימת המועמדים (במסגרת המגבלה היומית והיומן) ולא נשלחות למעסיקים. ל-Salesforce הן נשלחות רק לשדה שמנהל מערכת קישר." />
      )}

      <h2 id="settings-job" className="font-RubikBold fs-4 mt-4" tabIndex={-1}>טופס משרה ופרסום משרות</h2>
      {fields && (
        <CustomFieldsEditor form="job" fields={fields} onChanged={load} salesforce={salesforce} isAdmin={isAdmin} title="שדות נוספים במשרה"
          intro="שדות שתוסיפו כאן מופיעים בטופס המשרה של הצוות (גם לרכזי השמה). הם מופיעים גם בטופס המעסיקים ובבקשות העריכה שלהם. שדה שסומן 'להציג בעמוד המשרה' מוצג לכל מי שרואה את המשרה (גם ב-API הציבורי); האחרים לצוות בלבד. ל-Salesforce נשלח רק שדה שמנהל מערכת קישר." />
      )}
      <section className="sec-card" aria-labelledby="settings-job-lists-h">
        <div className="sec-card__head"><h2 id="settings-job-lists-h">שדות קבועים במשרה</h2></div>
        <p className="sec-muted mb-1">תנאי הסף נקבע בכל משרה בנפרד, בטופס המשרה (מנהלי תוכן בלבד).</p>
        <Help label="למה אי אפשר להוסיף ערכים להיקף משרה או לתחומים?">
          <p className="mb-0">הרשימות הקבועות במשרה (היקף משרה, מיומנויות) עוברות כמו שהן ל-Salesforce. ערך חדש בהן היה נשלח
            לשדה שלא מכיר אותו, ולכן מידע נוסף מוסיפים כשדה נוסף משלכם (למעלה) ולא כערך ברשימה קבועה.</p>
        </Help>
      </section>

      {/* Owner, 23.11.2026: the employer posting setting belongs to job posting, not to applying. */}
      <section className="sec-card" aria-labelledby="settings-posting-h" id="settings-posting">
        <div className="sec-card__head"><h2 id="settings-posting-h">פרסום משרות על ידי מעסיקים</h2></div>
        <EmployerPostingSettings />
      </section>

      <h2 id="settings-apply" className="font-RubikBold fs-4 mt-4" tabIndex={-1}>הגשה למשרות</h2>
      <section className="sec-card" aria-labelledby="settings-apply-h">
        <div className="sec-card__head"><h2 id="settings-apply-h">דרכי הגשה למשרות</h2></div>
        <ApplyPolicySettings />
      </section>
    </div>
  );
}
