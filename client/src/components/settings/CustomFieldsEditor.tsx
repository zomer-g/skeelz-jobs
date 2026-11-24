// Added fields of one form (sign-up / job) on the settings screen (/settings): list, add, edit, turn off / on, reorder.
// A field is never deleted (its answers stay readable); the type is chosen once. Server: GET/POST/PATCH
// /api/admin/settings/custom-fields (content managers and admins), logged as settings.custom_field_created / _updated.
import { useState } from 'react';
import { Chip, Dialog, api } from '../security/ui';
import { CustomFieldDef, CustomFieldForm, CustomFieldType, SalesforceFieldStatus } from '../../utils/customFields';
import SaveButton from './SaveButton';

// Salesforce (owner, 23.11.2026): an added field goes there only once an admin linked it to a field that exists in the
// org (Contact for the sign-up form, the Position Case for the job form). Nothing is created in Salesforce from here.
export const SF_NOT_SENT = 'לא נשלח ל-Salesforce עד שייווצר ויקושר שדה מתאים';
const SF_REASON: Partial<Record<SalesforceFieldStatus, string>> = {
  missing: 'השדה המקושר לא נמצא ב-Salesforce (או שאין למשתמש האינטגרציה הרשאת קריאה)',
  wrong_type: 'סוג השדה ב-Salesforce לא מתאים לסוג השדה כאן',
  not_writable: 'למשתמש האינטגרציה אין הרשאת עריכה לשדה',
  unknown: 'לא הצלחנו לבדוק מול Salesforce כרגע',
};
const SF_LINK_ERRORS: Record<string, string> = {
  sf_field_invalid: 'שם API של שדה מותאם, שמסתיים ב-__c (למשל Shift__c).',
  sf_field_reserved: 'האתר כבר כותב לשדה הזה. בחרו שדה אחר.',
  sf_field_taken: 'שדה אחר בטופס הזה כבר מקושר לשדה הזה ב-Salesforce.',
};
export type SalesforceInfo = { enabled: boolean; status: Record<string, SalesforceFieldStatus> };
/** Active fields of this form that don't reach Salesforce (for the section's summary warning). */
export const unsentCount = (fields: CustomFieldDef[], form: CustomFieldForm, sf?: SalesforceInfo) =>
  fields.filter((f) => f.form === form && f.active && (sf?.status[f.id] ?? 'not_linked') !== 'ok').length;

const TYPE_LABELS: Record<CustomFieldType, string> = { text: 'טקסט חופשי', select: 'בחירה מרשימה', checkbox: 'תיבת סימון (כן)' };
const ERRORS: Record<string, string> = {
  bad_label: 'שם השדה צריך להיות 2–80 תווים.',
  bad_options: 'ברשימה צריכות להיות לפחות 2 אפשרויות שונות (שורה לכל אפשרות, עד 80 תווים כל אחת).',
  bad_help: 'ההסבר ארוך מדי.',
  too_many_fields: 'הגעתם למספר השדות המרבי בטופס הזה. אפשר לכבות שדה ישן ולערוך אותו במקום להוסיף חדש.',
};

type Draft = { label: string; type: CustomFieldType; options: string; required: boolean; help: string; showOnJobPage: boolean };
const EMPTY: Draft = { label: '', type: 'text', options: '', required: false, help: '', showOnJobPage: false };

export default function CustomFieldsEditor({ form, fields, onChanged, title, intro, salesforce, isAdmin = false }: {
  form: CustomFieldForm; fields: CustomFieldDef[]; onChanged: () => Promise<unknown>; title: string; intro: string;
  salesforce?: SalesforceInfo; isAdmin?: boolean;
}) {
  const sfObject = form === 'signup' ? 'Contact' : 'Case (משרה)';
  const [linking, setLinking] = useState<CustomFieldDef | null>(null);
  const [sfName, setSfName] = useState('');
  const [linkError, setLinkError] = useState('');
  const unsent = unsentCount(fields, form, salesforce);
  const sfLine = (f: CustomFieldDef) => {
    const st = salesforce?.status[f.id] ?? 'not_linked';
    if (st === 'ok') return <Chip tone="ok">נשלח ל-Salesforce ({f.sfField})</Chip>;
    if (st === 'salesforce_off') return <span className="sec-muted">מקושר ל-{f.sfField}; החיבור ל-Salesforce כבוי באתר כרגע</span>;
    return (
      <span data-testid={`cf-sf-warning-${f.id}`}>
        <Chip tone="warn">{SF_NOT_SENT}</Chip>
        {f.sfField && SF_REASON[st] && <span className="sec-muted d-block">{f.sfField}: {SF_REASON[st]}</span>}
      </span>
    );
  };
  const saveLink = async (e: React.FormEvent, value: string | null) => {
    e.preventDefault();
    if (!linking) return;
    setBusy(true); setLinkError('');
    try {
      await api(`/admin/security/salesforce/custom-fields/${linking.id}`, { method: 'PUT', body: JSON.stringify({ sfField: value }) });
      await onChanged();
      setLinking(null);
      setMsg({ tone: 'ok', text: value ? `השדה "${linking.label}" קושר ל-${value}.` : `הקישור של "${linking.label}" הוסר.` });
    } catch (err) {
      setLinkError(SF_LINK_ERRORS[(err as Error).message] ?? 'השמירה לא הצליחה. נסו שוב.');
    } finally {
      setBusy(false);
    }
  };
  const list = fields.filter((f) => f.form === form).sort((a, b) => a.sortOrder - b.sortOrder);
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'alert'; text: string } | null>(null);
  const [formError, setFormError] = useState('');
  const h = `cf-${form}-h`;

  const fail = (e: unknown) => ERRORS[(e as Error).message] ?? 'השמירה לא הצליחה. נסו שוב.';

  const openNew = () => { setEditing(null); setDraft(EMPTY); setFormError(''); setOpen(true); };
  const openEdit = (f: CustomFieldDef) => {
    setEditing(f);
    setDraft({ label: f.label, type: f.type, options: f.options.join('\n'), required: f.required, help: f.help, showOnJobPage: f.showOnJobPage });
    setFormError(''); setOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setFormError('');
    const body: Record<string, unknown> = {
      label: draft.label, required: draft.required, help: draft.help,
      options: draft.type === 'select' ? draft.options.split('\n').map((o) => o.trim()).filter(Boolean) : [],
      ...(form === 'job' ? { showOnJobPage: draft.showOnJobPage } : {}),
    };
    try {
      if (editing) await api(`/admin/settings/custom-fields/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/admin/settings/custom-fields', { method: 'POST', body: JSON.stringify({ ...body, form, type: draft.type }) });
      await onChanged();
      setOpen(false);
      setMsg({ tone: 'ok', text: editing ? `השדה "${draft.label.trim()}" עודכן.` : `השדה "${draft.label.trim()}" נוסף לטופס.` });
    } catch (err) {
      setFormError(fail(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (f: CustomFieldDef, body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg(null);
    try {
      await api(`/admin/settings/custom-fields/${f.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await onChanged();
      setMsg({ tone: 'ok', text: done });
    } catch (err) {
      setMsg({ tone: 'alert', text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  /** Up / down: the two neighbours swap places (order numbers 10, 20, 30… so nothing collides). */
  const move = async (i: number, dir: -1 | 1) => {
    const a = list[i]; const b = list[i + dir];
    if (!a || !b) return;
    setBusy(true); setMsg(null);
    try {
      const ordered = list.map((f, k) => ({ f, order: (k + 1) * 10 }));
      [ordered[i].order, ordered[i + dir].order] = [ordered[i + dir].order, ordered[i].order];
      for (const { f, order } of ordered) {
        if (f.sortOrder !== order) await api(`/admin/settings/custom-fields/${f.id}`, { method: 'PATCH', body: JSON.stringify({ sortOrder: order }) });
      }
      await onChanged();
      setMsg({ tone: 'ok', text: `הסדר עודכן.` });
    } catch (err) {
      setMsg({ tone: 'alert', text: fail(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sec-card" aria-labelledby={h} data-testid={`custom-fields-${form}`}>
      <div className="sec-card__head">
        <h2 id={h}>{title}</h2>
        <button type="button" className="sec-btn sec-btn--primary" onClick={openNew} disabled={busy} data-testid={`custom-fields-${form}-add`}>
          <i className="bi bi-plus-lg" aria-hidden="true" />הוספת שדה
        </button>
      </div>
      <p className="sec-muted mb-2">{intro}</p>
      {unsent > 0 && (
        <p role="note" className="sec-note mb-2" data-testid={`custom-fields-${form}-sf-summary`}>
          <i className="bi bi-exclamation-circle-fill" aria-hidden="true" /> {unsent === 1 ? 'שדה פעיל אחד' : `${unsent} שדות פעילים`} בטופס הזה: {SF_NOT_SENT}.
          {' '}{isAdmin ? `מקשרים כל שדה לשדה ב-${sfObject} בכפתור "Salesforce" בשורה שלו.` : 'הקישור נעשה על ידי מנהל מערכת, אחרי שהשדה נוצר ב-Salesforce.'}
        </p>
      )}
      {list.length === 0 ? <p className="sec-muted">עוד לא נוספו שדות.</p> : (
        <table className="sec-table sec-table--stack">
          <thead><tr>
            <th scope="col">שדה</th><th scope="col">סוג</th><th scope="col">בטופס</th><th scope="col">מצב</th>
            <th scope="col"><span className="visually-hidden">פעולות</span></th>
          </tr></thead>
          <tbody>
            {list.map((f, i) => (
              <tr key={f.id}>
                <td className="sec-cell-main">
                  {f.label}
                  {f.type === 'select' && <div className="sec-muted">{f.options.join(' · ')}</div>}
                  {f.help && <div className="sec-muted">{f.help}</div>}
                </td>
                <td data-label="סוג">{TYPE_LABELS[f.type]}</td>
                <td data-label="בטופס">
                  {f.required ? 'חובה' : 'רשות'}
                  {form === 'job' && <div className="sec-muted">{f.showOnJobPage ? 'מוצג בעמוד המשרה' : 'לצוות בלבד'}</div>}
                </td>
                <td data-label="מצב">
                  {f.active ? <Chip tone="ok">פעיל</Chip> : <Chip tone="muted">כבוי</Chip>}
                  {f.active && <div className="mt-1">{sfLine(f)}</div>}
                </td>
                <td><div className="sec-actions">
                  <button type="button" className="sec-btn" disabled={busy || i === 0} aria-label={`להזיז למעלה: ${f.label}`} onClick={() => move(i, -1)}>
                    <i className="bi bi-arrow-up" aria-hidden="true" />
                  </button>
                  <button type="button" className="sec-btn" disabled={busy || i === list.length - 1} aria-label={`להזיז למטה: ${f.label}`} onClick={() => move(i, 1)}>
                    <i className="bi bi-arrow-down" aria-hidden="true" />
                  </button>
                  <button type="button" className="sec-btn" disabled={busy} aria-label={`עריכה: ${f.label}`} onClick={() => openEdit(f)}>עריכה</button>
                  {isAdmin && (
                    <button type="button" className="sec-btn" disabled={busy} aria-label={`קישור ל-Salesforce: ${f.label}`} data-testid={`cf-sf-link-${f.id}`}
                      onClick={() => { setLinking(f); setSfName(f.sfField ?? ''); setLinkError(''); }}>Salesforce</button>
                  )}
                  {f.active ? (
                    <button type="button" className="sec-btn sec-btn--danger" disabled={busy} aria-label={`כיבוי: ${f.label}`}
                      onClick={() => window.confirm(`לכבות את השדה "${f.label}"? הוא לא יוצג בטופס, והתשובות שכבר נשמרו יישארו גלויות לצוות.`)
                        && patch(f, { active: false }, `השדה "${f.label}" כובה.`)}>כיבוי</button>
                  ) : (
                    <button type="button" className="sec-btn" disabled={busy} aria-label={`הפעלה: ${f.label}`}
                      onClick={() => patch(f, { active: true }, `השדה "${f.label}" הופעל.`)}>הפעלה</button>
                  )}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p role="status" aria-live="polite" className="mt-2 mb-0">{msg && <Chip tone={msg.tone}>{msg.text}</Chip>}</p>

      <Dialog open={!!linking} title={linking ? `קישור ל-Salesforce: ${linking.label}` : ''} onClose={() => setLinking(null)}>
        <form onSubmit={(e) => saveLink(e, sfName.trim() || null)} noValidate>
          <p className="sec-muted">
            צרו קודם ב-Salesforce שדה מותאם ב-{sfObject} ({linking?.type === 'checkbox' ? 'Checkbox' : linking?.type === 'select' ? 'Picklist עם אותן אפשרויות בדיוק, או Text' : 'Text או Long Text Area'}),
            ותנו למשתמש האינטגרציה הרשאת עריכה. האתר לא יוצר ולא מוחק שדות ב-Salesforce, ושולח רק אחרי שהשדה נמצא שם. תשובות שכבר נשמרו נשלחות בעדכון הבא של כל רשומה.
          </p>
          <label className="sec-field">
            <span>שם ה-API של השדה ב-Salesforce</span>
            <input className="form-control" dir="ltr" maxLength={40} placeholder="Shift__c" value={sfName}
              onChange={(e) => setSfName(e.target.value)} data-testid="cf-sf-name" />
          </label>
          {linkError && <p role="alert" className="mb-2"><Chip tone="alert">{linkError}</Chip></p>}
          <div className="sec-dialog__actions">
            <button className="sec-btn sec-btn--primary" type="submit" disabled={busy || !sfName.trim()} data-testid="cf-sf-save">קישור ובדיקה</button>
            {linking?.sfField && <button type="button" className="sec-btn sec-btn--danger" disabled={busy} onClick={(e) => saveLink(e as any, null)}>הסרת הקישור</button>}
            <button type="button" className="sec-btn" onClick={() => setLinking(null)}>ביטול</button>
          </div>
        </form>
      </Dialog>

      <Dialog open={open} title={editing ? `עריכת שדה: ${editing.label}` : 'הוספת שדה'} onClose={() => setOpen(false)}>
        <form onSubmit={save} noValidate>
          <label className="sec-field">
            <span>שם השדה (כפי שיופיע בטופס)</span>
            <input className="form-control" required minLength={2} maxLength={80} value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })} data-testid="cf-label" />
          </label>
          <label className="sec-field">
            <span>סוג</span>
            <select className="form-select" value={draft.type} disabled={!!editing} aria-describedby={`cf-type-hint-${form}`}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as CustomFieldType })} data-testid="cf-type">
              {(Object.keys(TYPE_LABELS) as CustomFieldType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
            <small id={`cf-type-hint-${form}`} className="sec-muted">{editing ? 'את הסוג אי אפשר לשנות אחרי שנוצר השדה.' : 'את הסוג בוחרים פעם אחת.'}</small>
          </label>
          {draft.type === 'select' && (
            <label className="sec-field">
              <span>האפשרויות (שורה לכל אפשרות)</span>
              <textarea className="form-control" rows={4} value={draft.options}
                onChange={(e) => setDraft({ ...draft, options: e.target.value })} data-testid="cf-options" />
            </label>
          )}
          <label className="sec-field">
            <span>הסבר קצר מתחת לשדה (לא חובה)</span>
            <input className="form-control" maxLength={200} value={draft.help} onChange={(e) => setDraft({ ...draft, help: e.target.value })} />
          </label>
          <label className="d-flex align-items-center gap-2 mb-2">
            <input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} data-testid="cf-required" />
            {draft.type === 'checkbox' ? 'חובה לסמן' : 'שדה חובה'}
          </label>
          {form === 'job' && (
            <label className="d-flex align-items-center gap-2 mb-2">
              <input type="checkbox" checked={draft.showOnJobPage} onChange={(e) => setDraft({ ...draft, showOnJobPage: e.target.checked })} />
              להציג בעמוד המשרה (גלוי לכולם)
            </label>
          )}
          {formError && <p role="alert" className="mb-2"><Chip tone="alert">{formError}</Chip></p>}
          <div className="sec-dialog__actions">
            <SaveButton disabled={busy || draft.label.trim().length < 2} testId="cf-save" label={editing ? 'שמירה' : 'הוספה'} />
            <button type="button" className="sec-btn" onClick={() => setOpen(false)}>ביטול</button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
