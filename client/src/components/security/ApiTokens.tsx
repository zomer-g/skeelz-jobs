// Internal API tokens (both staff roles): create a token with a name, scopes and an expiry,
// see it ONCE, revoke any token, see when each was last used. Shown to the admin on the security
// screen and to the content manager on jobs management. Only the scopes the server says THIS user
// may issue are offered (`issuable`): people scopes are for the content manager only; the server
// enforces the same rule. Server: server/src/internalApi/tokensController.ts. Create/revoke are logged.
import { useEffect, useState } from 'react';

type Token = {
  id: string; name: string; prefix: string; actor: string; scopes: string[]; createdBy: string; createdAt: string;
  expiresAt: string; revokedAt: string | null; revokedBy: string | null; lastUsedAt: string | null;
  state: 'active' | 'expired' | 'revoked';
};
type ListData = {
  tokens: Token[]; scopes: Record<string, string>; issuable: string[]; days: { default: number; max: number }; secretEnabled: boolean;
};

const STATE_LABELS: Record<Token['state'], string> = { active: 'פעיל', expired: 'פג תוקף', revoked: 'בוטל' };

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

export default function ApiTokens() {
  const [data, setData] = useState<ListData | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [days, setDays] = useState<number | ''>('');
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/admin/api-tokens').then((d: ListData) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('/admin/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, expiresInDays: days === '' ? undefined : days }),
      });
      setCreated({ token: r.token, name: r.name });
      setName(''); setScopes([]); setDays('');
      await load();
    } catch (err) { window.alert((err as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (t: Token) => {
    if (!window.confirm(`לבטל את המפתח "${t.name}" (${t.prefix})? מערכת שמשתמשת בו תיחסם מיד.`)) return;
    try { await api(`/admin/api-tokens/${t.id}/revoke`, { method: 'POST', body: '{}' }); await load(); }
    catch (err) { window.alert((err as Error).message); }
  };

  if (!data) return <div className="mt-4">{error || 'טוען מפתחות API…'}</div>;
  const toggle = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <section className="mt-4" aria-labelledby="api-tokens-title">
      <h4 id="api-tokens-title">מפתחות API פנימיים</h4>
      <p>
        מפתח זמני למערכת של SKEELZ שמתחברת לאתר דרך הממשק הפנימי. כל מפתח מקבל רק את ההרשאות
        שסומנו, עד {data.days.max} יום (ברירת מחדל {data.days.default}). מועמדים וקורות חיים דרך מפתח נספרים באותן מגבלות
        יומיות ונרשמים ביומן כמו אצל מנהל/ת תוכן, בשם <span dir="ltr">token:&lt;קידומת&gt;</span>. המפתח מוצג פעם אחת בלבד.
        רק מנהל/ת תוכן יכול/ה להנפיק מפתח שקורא מועמדים, הגשות או קורות חיים; מנהל מערכת רואה את כל המפתחות ויכול לבטל כל מפתח.
        {' '}סוד השרת (<span dir="ltr">INTERNAL_API_SECRET</span>): {data.secretEnabled ? 'מוגדר' : 'לא מוגדר (כבוי)'}.
      </p>

      {created && (
        <div role="status" className="p-3 mb-3" style={{ border: '2px solid #1a7f37', borderRadius: 6 }}>
          <p className="mb-1"><b>המפתח "{created.name}" נוצר.</b> העתיקו אותו עכשיו — הוא לא יוצג שוב.</p>
          <code dir="ltr" style={{ display: 'block', overflowWrap: 'anywhere', userSelect: 'all' }}>{created.token}</code>
          <div className="mt-2 d-flex gap-2">
            <button type="button" className="btn btn-sm btn-dark" onClick={() => navigator.clipboard?.writeText(created.token)}>העתקה</button>
            <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => setCreated(null)}>סגירה</button>
          </div>
        </div>
      )}

      <form onSubmit={create} className="mb-3">
        <div className="d-flex gap-2 flex-wrap align-items-end">
          <label className="d-flex flex-column">
            שם המערכת
            <input className="form-control" style={{ maxWidth: 260 }} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="d-flex flex-column">
            תוקף בימים (1–{data.days.max})
            <input className="form-control" style={{ maxWidth: 140 }} type="number" min={1} max={data.days.max} placeholder={String(data.days.default)}
              value={days} onChange={(e) => setDays(e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
        </div>
        <fieldset className="mt-2">
          <legend style={{ fontSize: 'inherit' }}>הרשאות</legend>
          {Object.entries(data.scopes).filter(([s]) => data.issuable.includes(s)).map(([s, label]) => (
            <label key={s} className="d-block">
              <input type="checkbox" className="ms-2" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              <span dir="ltr">{s}</span> — {label}
            </label>
          ))}
        </fieldset>
        <button className="btn btn-dark mt-2" type="submit" disabled={busy || !name.trim() || !scopes.length}>יצירת מפתח</button>
      </form>

      {data.tokens.length === 0 ? <p>אין מפתחות.</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr>
            <th style={cell}>שם</th><th style={cell}>קידומת</th><th style={cell}>הרשאות</th><th style={cell}>מצב</th>
            <th style={cell}>נוצר</th><th style={cell}>תוקף עד</th><th style={cell}>שימוש אחרון</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {data.tokens.map((t) => (
              <tr key={t.id}>
                <td style={cell}>{t.name}</td>
                <td style={{ ...cell, direction: 'ltr' }}>{t.prefix}</td>
                <td style={{ ...cell, direction: 'ltr' }}>{t.scopes.join(', ')}</td>
                <td style={{ ...cell, color: t.state === 'active' ? 'inherit' : '#b00020' }}>
                  {STATE_LABELS[t.state]}{t.revokedAt ? ` (${fmt(t.revokedAt)}, ${t.revokedBy})` : ''}
                </td>
                <td style={cell}>{fmt(t.createdAt)}<br /><small>{t.createdBy}</small></td>
                <td style={cell}>{fmt(t.expiresAt)}</td>
                <td style={cell}>{fmt(t.lastUsedAt)}</td>
                <td style={cell}>
                  {t.state === 'active' && <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => revoke(t)}>ביטול</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
