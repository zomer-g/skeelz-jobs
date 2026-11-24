// Candidate sign-up fields on the settings screen (/settings; was on the candidates screen until 23.11.2026): for each field, required / optional (the ID number also
// "not asked"). First and last name are always required; the email comes from the sign-in. The server enforces the
// setting on every sign-up and in the personal area. Server: GET/PUT /api/admin/settings/signup-fields (content managers and admins),
// logged as settings.signup_fields_updated. Rules: docs/security.md.
import { useEffect, useState } from 'react';
import { Chip, Help, api } from '../security/ui';
import { SignupField, SignupFieldMode, SignupFields, loadSignupFields } from '../../utils/signupFields';
import SaveButton from './SaveButton';

const FIELD_LABELS: Record<SignupField, string> = {
  phoneNumber: 'טלפון', citySymbol: 'עיר מגורים', gender: 'מגדר', dateOfBirth: 'תאריך לידה', idNumber: 'תעודת זהות',
};
const MODE_LABELS: Record<SignupFieldMode, string> = { required: 'חובה', optional: 'רשות', hidden: 'לא לשאול' };
const ORDER: SignupField[] = ['dateOfBirth', 'idNumber', 'phoneNumber', 'citySymbol', 'gender'];

export default function SignupFieldsSettings() {
  const [fields, setFields] = useState<SignupFields | null>(null);
  const [modes, setModes] = useState<Record<SignupField, SignupFieldMode[]> | null>(null);
  const [saved, setSaved] = useState<SignupFields | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'alert'; text: string } | null>(null);

  useEffect(() => {
    api('/admin/settings/signup-fields')
      .then((d) => { setFields(d.fields); setSaved(d.fields); setModes(d.modes); })
      .catch(() => setMsg({ tone: 'alert', text: 'לא הצלחנו לקרוא את ההגדרה.' }));
  }, []);

  const changed = fields && saved ? ORDER.filter((f) => fields[f] !== saved[f]) : [];

  const save = async () => {
    if (!fields || !changed.length) return;
    setBusy(true); setMsg(null);
    try {
      const d = await api('/admin/settings/signup-fields', { method: 'PUT', body: JSON.stringify(Object.fromEntries(changed.map((f) => [f, fields[f]]))) });
      setFields(d.fields); setSaved(d.fields);
      void loadSignupFields(true);
      setMsg({ tone: 'ok', text: 'נשמר. ההרשמה והאזור האישי פועלים לפי ההגדרה החדשה.' });
    } catch {
      setMsg({ tone: 'alert', text: 'השמירה לא הצליחה. נסו שוב.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sec-card" aria-labelledby="sec-signup-fields-h">
      <div className="sec-card__head"><h2 id="sec-signup-fields-h" tabIndex={-1}>שדות בטופס ההרשמה</h2></div>
      <p className="sec-muted mb-2">אילו פרטים מועמד חייב למלא בהרשמה ובאזור האישי. שם פרטי ושם משפחה תמיד חובה; המייל מגיע מההתחברות.</p>
      <Help>
        <p className="mb-1">"חובה" נבדק גם בשרת, כך שאי אפשר לדלג עליו. "רשות" מוצג בלי כוכבית ואפשר להשאיר ריק. בתעודת זהות אפשר גם "לא לשאול": השדה לא מוצג כלל.</p>
        <p className="mb-0">תעודת זהות נבדקת לפי ספרת הביקורת. היא לא נכתבת ביומן הפעילות, בלוגים או באנליטיקס, לא מוצגת למעסיקים, ומוצגת לצוות רק ברשימת המועמדים (שנספרת במכסה היומית ונרשמת ביומן). היא נשלחת ל-Salesforce רק אם בארגון יש שדה ID_Number__c ב-Contact.</p>
      </Help>
      {!fields || !modes ? (msg ? <p role="alert"><Chip tone="alert">{msg.text}</Chip></p> : <p className="sec-muted">טוען…</p>) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <table className="sec-table sec-table--stack mt-2">
            <thead><tr><th scope="col">שדה</th><th scope="col">בטופס</th></tr></thead>
            <tbody>
              {ORDER.map((f) => (
                <tr key={f}>
                  <td className="sec-cell-main">{FIELD_LABELS[f]}</td>
                  <td data-label="בטופס">
                    <fieldset className="d-flex flex-wrap gap-3 m-0 p-0 border-0">
                      <legend className="visually-hidden">{FIELD_LABELS[f]}</legend>
                      {(modes[f] ?? ['required', 'optional']).map((m) => (
                        <label key={m} className="d-inline-flex align-items-center gap-1" htmlFor={`signup-field-${f}-${m}`}>
                          <input type="radio" id={`signup-field-${f}-${m}`} name={`signup-field-${f}`} value={m}
                            checked={fields[f] === m} onChange={() => { setFields({ ...fields, [f]: m }); setMsg(null); }} />
                          {MODE_LABELS[m]}
                        </label>
                      ))}
                    </fieldset>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="d-flex align-items-center gap-3 mt-2 flex-wrap">
            <SaveButton disabled={busy || !changed.length} testId="signup-fields-save" />
            {changed.length > 0 && <span className="sec-muted">{changed.length} שינויים שלא נשמרו</span>}
            <span role="status" aria-live="polite">{msg && <Chip tone={msg.tone}>{msg.text}</Chip>}</span>
          </div>
        </form>
      )}
    </section>
  );
}
