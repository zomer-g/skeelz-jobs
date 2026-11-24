// Internal API keys (admins only, owner 20.11.2026): a table of keys, "new key" in a dialog, the key shown ONCE,
// revoke. Shown only on the admin security screen. Only the scopes the server says THIS
// user may issue are offered (`issuable`); the server enforces the same rule.
// Server: server/src/internalApi/tokensController.ts. Create/revoke are logged.
import { useEffect, useState } from 'react';
import { Chip, Dialog, Help, Tone, api, fmtDate, relTime } from './ui';

type Token = {
  id: string; name: string; prefix: string; actor: string; scopes: string[]; createdBy: string; createdAt: string;
  expiresAt: string; revokedAt: string | null; revokedBy: string | null; lastUsedAt: string | null;
  state: 'active' | 'expired' | 'revoked';
};
type ListData = {
  tokens: Token[]; scopes: Record<string, string>; issuable: string[]; days: { default: number; max: number }; secretEnabled: boolean;
};

const STATE: Record<Token['state'], { label: string; tone: Tone }> = {
  active: { label: 'פעיל', tone: 'ok' }, expired: { label: 'פג תוקף', tone: 'muted' }, revoked: { label: 'בוטל', tone: 'muted' },
};

/** Active keys count, for the security summary tile. */
export const countActiveTokens = (tokens: { state: string }[]) => tokens.filter((t) => t.state === 'active').length;

export default function ApiTokens({ onChange, headingLevel = 2 }: { onChange?: (activeCount: number) => void; headingLevel?: 2 | 3 }) {
  const [data, setData] = useState<ListData | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [days, setDays] = useState<number | ''>('');
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);

  const load = () => api('/admin/api-tokens').then((d: ListData) => {
    setData(d); setError(''); onChange?.(countActiveTokens(d.tokens));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const openNew = () => { setName(''); setScopes([]); setDays(''); setCreated(null); setCopied(false); setDialog(true); };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('/admin/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, expiresInDays: days === '' ? undefined : days }),
      });
      setCreated({ token: r.token, name: r.name });
      await load();
    } catch (err) { window.alert((err as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (t: Token) => {
    if (!window.confirm(`לבטל את המפתח "${t.name}"? מערכת שמשתמשת בו תיחסם מיד.`)) return;
    try { await api(`/admin/api-tokens/${t.id}/revoke`, { method: 'POST', body: '{}' }); await load(); }
    catch (err) { window.alert((err as Error).message); }
  };

  const H = `h${headingLevel}` as 'h2' | 'h3';
  if (!data) return <section className="sec-card" aria-busy="true"><H>מפתחות API</H><p className="sec-empty">{error || 'טוען…'}</p></section>;
  const toggle = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const active = data.tokens.filter((t) => t.state === 'active');
  const shown = showOld ? data.tokens : active;

  return (
    <section className="sec-card" aria-labelledby="api-tokens-title" id="api-tokens" tabIndex={-1}>
      <div className="sec-card__head">
        <H id="api-tokens-title">מפתחות API ({active.length} פעילים)</H>
        <button type="button" className="sec-btn sec-btn--primary" onClick={openNew}><i className="bi bi-plus-lg" aria-hidden="true" />מפתח חדש</button>
      </div>
      <p className="sec-card__hint">גישה זמנית של מערכת של SKEELZ לממשק הפנימי.</p>
      <Help>
        <p>כל מפתח מקבל רק את ההרשאות שנבחרו, לעד {data.days.max} יום (ברירת מחדל {data.days.default}), ומוצג פעם אחת בלבד.
          מועמדים וקורות חיים דרך מפתח נספרים במגבלות היומיות ונרשמים ביומן בשם <span className="sec-ltr">token:&lt;קידומת&gt;</span>.
          רק מנהל מערכת מנפיק ומבטל מפתחות.</p>
        <p>סוד השרת (<span className="sec-ltr">INTERNAL_API_SECRET</span>): {data.secretEnabled ? 'מוגדר' : 'לא מוגדר (כבוי)'}.</p>
      </Help>

      {shown.length === 0 ? <p className="sec-empty">אין מפתחות פעילים.</p> : (
        <table className="sec-table sec-table--stack">
          <thead><tr><th scope="col">שם</th><th scope="col">הרשאות</th><th scope="col">מצב</th><th scope="col">תוקף עד</th><th scope="col">שימוש אחרון</th><th scope="col"><span className="visually-hidden">פעולות</span></th></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td className="sec-cell-main">{t.name}<div className="sec-muted sec-ltr">{t.prefix}</div></td>
                <td data-label="הרשאות"><span className="sec-ltr sec-muted">{t.scopes.join(', ')}</span></td>
                <td data-label="מצב"><Chip tone={STATE[t.state].tone}>{STATE[t.state].label}</Chip></td>
                <td data-label="תוקף עד">{fmtDate(t.expiresAt)}</td>
                <td data-label="שימוש אחרון">{t.lastUsedAt ? relTime(t.lastUsedAt) : 'לא נעשה שימוש'}</td>
                <td><div className="sec-actions">
                  {t.state === 'active' && <button type="button" className="sec-btn sec-btn--danger" onClick={() => revoke(t)} aria-label={`ביטול המפתח ${t.name}`}>ביטול</button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.tokens.length > active.length && (
        <button type="button" className="sec-btn mt-2" aria-pressed={showOld} onClick={() => setShowOld(!showOld)}>
          {showOld ? 'הסתר מפתחות שבוטלו או פגו' : `הצג גם ${data.tokens.length - active.length} שבוטלו או פגו`}
        </button>
      )}

      <Dialog open={dialog} title={created ? 'המפתח נוצר' : 'מפתח API חדש'} onClose={() => setDialog(false)}>
        {created ? (
          <>
            <p role="status"><b>{created.name}</b> — העתיקו את המפתח עכשיו. הוא לא יוצג שוב.</p>
            <code className="sec-token">{created.token}</code>
            <div className="sec-dialog__actions">
              <button type="button" className="sec-btn sec-btn--primary" onClick={() => { navigator.clipboard?.writeText(created.token); setCopied(true); }}>
                <i className="bi bi-clipboard" aria-hidden="true" />{copied ? 'הועתק' : 'העתקה'}
              </button>
              <button type="button" className="sec-btn" onClick={() => setDialog(false)}>סגירה</button>
            </div>
          </>
        ) : (
          <form onSubmit={create}>
            <label className="sec-field">
              <span>שם המערכת</span>
              <input className="form-control" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="sec-field">
              <span>תוקף בימים</span>
              <input className="form-control" type="number" min={1} max={data.days.max} placeholder={String(data.days.default)}
                value={days} onChange={(e) => setDays(e.target.value === '' ? '' : Number(e.target.value))} aria-describedby="days-hint" />
              <small id="days-hint" className="sec-muted">1–{data.days.max}, ריק = {data.days.default}</small>
            </label>
            <fieldset className="sec-scopes">
              <legend>הרשאות</legend>
              {Object.entries(data.scopes).filter(([s]) => data.issuable.includes(s)).map(([s, label]) => (
                <label key={s} className="sec-scope">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                  <span>{label}<br /><code className="sec-ltr">{s}</code></span>
                </label>
              ))}
            </fieldset>
            <div className="sec-dialog__actions">
              <button className="sec-btn sec-btn--primary" type="submit" disabled={busy || !name.trim() || !scopes.length}>יצירת מפתח</button>
              <button type="button" className="sec-btn" onClick={() => setDialog(false)}>ביטול</button>
            </div>
          </form>
        )}
      </Dialog>
    </section>
  );
}
