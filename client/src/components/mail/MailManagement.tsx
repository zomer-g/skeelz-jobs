// Service emails (/mail-management; content managers and admins): which events send an email, and the text of each.
// Server: /api/admin/mail* (src/mail, docs/mail.md). Every template is checked on the server (parameters, links,
// sizes), every saved version is kept, and the test send goes only to the signed-in editor's own address with sample
// values. Logged: mail.template_saved / _published / _reset, mail.event_enabled / _disabled, mail.test_sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chip, Help, api, fmtDateTime } from '../security/ui';

type Audience = 'candidate' | 'employer' | 'staff' | 'team';
interface EventRow {
  kind: string; audience: Audience; label: string; when: string; enabled: boolean; canDisable: boolean; locked: boolean;
  published: { id: string; at: string | null; by: string } | null;
}
interface Overview {
  emailOn: boolean; webhookConfigured: boolean; teamInboxSet?: boolean; events: EventRow[]; audiences: Record<Audience, string>;
  stats: Record<string, Record<string, number>>; suppressed: number;
}
interface Param { name: string; label: string; sample: string; link?: boolean }
interface Version { id: string; subject: string; body: string; createdBy: string; createdAt: string; publishedAt: string | null; isPublished: boolean }
interface KindDetail {
  kind: string; label: string; when: string; params: Param[]; required: string[];
  default: { subject: string; body: string }; current: { subject: string; body: string; versionId: string | null };
  versions: Version[]; limits: { subject: number; body: number };
}

const STATUS_LABELS: Record<string, string> = {
  sent: 'נשלחו', delivered: 'נמסרו', off: 'לא נשלחו (מייל כבוי)', failed: 'נכשלו', bounced: 'חזרו', complained: 'סומנו כספאם',
  suppressed: 'נחסמו (כתובת חסומה)', delayed: 'מתעכבים', no_recipient: 'לא נשלחו (אין כתובת לתיבת הצוות)',
};
const AUDIENCE_ORDER: Audience[] = ['candidate', 'employer', 'staff', 'team'];

const errorText = (e: string): string => {
  const [code, arg] = e.split(/:(.*)/s);
  switch (code) {
    case 'subject_empty': return 'חסרה שורת נושא.';
    case 'subject_too_long': return 'שורת הנושא ארוכה מדי.';
    case 'subject_multiline': return 'שורת הנושא חייבת להיות שורה אחת.';
    case 'body_empty': return 'חסר תוכן.';
    case 'body_too_long': return 'התוכן ארוך מדי.';
    case 'control_chars': return 'יש בטקסט תווים לא מוכרים.';
    case 'unknown_param': return `הפרמטר {{${arg}}} לא קיים במייל הזה.`;
    case 'missing_required': return `חובה להשאיר את הפרמטר {{${arg}}} (בלעדיו המייל לא עושה את תפקידו).`;
    case 'bad_link': return `קישור לא תקין: ${arg}. קישור חייב להתחיל ב-https:// או להיות אחד מפרמטרי הקישור.`;
    default: return e;
  }
};

export default function MailManagement() {
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'alert'; text: string } | null>(null);

  const load = useCallback(() => {
    api('/admin/mail').then((d: Overview) => { setData(d); setLoadError(false); }).catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);

  const toggle = async (e: EventRow) => {
    setBusyKind(e.kind); setMsg(null);
    try {
      await api(`/admin/mail/kinds/${e.kind}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: !e.enabled }) });
      setMsg({ tone: 'ok', text: `"${e.label}" ${!e.enabled ? 'הופעל' : 'כובה'}.` });
      load();
    } catch (err) {
      setMsg({ tone: 'alert', text: `השינוי לא נשמר: ${(err as Error).message}` });
    } finally { setBusyKind(null); }
  };

  if (loadError) return <div dir="rtl" className="board-frame sec-page"><p role="alert"><Chip tone="alert">לא הצלחנו לטעון את מסך המיילים.</Chip></p></div>;
  if (!data) return <div dir="rtl" className="board-frame sec-page"><p className="sec-muted">טוען…</p></div>;

  return (
    <div dir="rtl" className="board-frame sec-page" data-testid="mail-management">
      <div className="sec-page__head">
        <div>
          <h1 className="font-EzerRegularLoft display-6">מיילים מהאתר</h1>
          <p className="sec-page__sub">אילו מיילים האתר שולח, ומה כתוב בהם. אלה הודעות שירות בלבד: לא דיוור.</p>
        </div>
      </div>

      <div className="d-flex flex-wrap gap-2 mt-2" aria-label="מצב">
        {data.emailOn ? <Chip tone="ok">שליחת מיילים פעילה</Chip> : <Chip tone="warn">שליחת מיילים כבויה בשרת: שום מייל לא יוצא</Chip>}
        {data.webhookConfigured ? <Chip tone="ok">החזרות ותלונות מ-Resend נקלטות</Chip> : <Chip tone="muted">קליטת החזרות מ-Resend לא הוגדרה</Chip>}
        <Chip tone={data.suppressed ? 'warn' : 'muted'}>{data.suppressed} כתובות חסומות (חזרו או סומנו כספאם)</Chip>
      </div>
      <Help>
        <p className="mb-1">כל שורה היא אירוע באתר ששולח מייל. אירוע כבוי לא שולח כלום. מיילים חדשים למועמדים ולמעסיקים מתחילים כבויים.</p>
        <p className="mb-1">קוד הכניסה במייל תמיד פעיל כל עוד הכניסה בקוד פתוחה, ואם התבנית שלו לא תקינה נשלח הנוסח המקורי.</p>
        <p className="mb-0">"נוסח מקורי" הוא הטקסט שבקוד. כל שמירה נשמרת כגרסה; רק גרסה ש"פורסמה" נשלחת. אפשר לחזור לכל גרסה קודמת.</p>
      </Help>
      {msg && <p role="status" className="mt-2"><Chip tone={msg.tone}>{msg.text}</Chip></p>}

      {AUDIENCE_ORDER.map((aud) => {
        const rows = data.events.filter((e) => e.audience === aud);
        if (!rows.length) return null;
        return (
          <section key={aud} className="sec-card" aria-labelledby={`mail-aud-${aud}`}>
            <div className="sec-card__head"><h2 id={`mail-aud-${aud}`}>{data.audiences[aud]}</h2></div>
            {aud === 'team' && data.teamInboxSet === false && (
              <p className="mb-2" role="note" data-testid="mail-team-inbox-missing"><Chip tone="warn">לא הוגדרה בשרת כתובת לתיבת הצוות (APPLICATION_NOTIFICATION_EMAIL): המיילים האלה לא יוצאים, גם כשהם פעילים</Chip></p>
            )}
            <table className="sec-table sec-table--stack">
              <thead><tr><th scope="col">מייל</th><th scope="col">פעיל</th><th scope="col">נוסח</th><th scope="col">30 ימים אחרונים</th><th scope="col"><span className="visually-hidden">פעולות</span></th></tr></thead>
              <tbody>
                {rows.map((e) => {
                  const s = data.stats[e.kind] ?? {};
                  const counts = Object.entries(s).map(([k, n]) => `${STATUS_LABELS[k] ?? k}: ${n}`).join(' · ');
                  return (
                    <tr key={e.kind} data-testid={`mail-row-${e.kind}`}>
                      <td className="sec-cell-main"><strong>{e.label}</strong><div className="sec-muted">{e.when}</div></td>
                      <td data-label="פעיל">
                        <label className="d-inline-flex align-items-center gap-2" htmlFor={`mail-on-${e.kind}`}>
                          <input type="checkbox" role="switch" id={`mail-on-${e.kind}`} checked={e.enabled}
                            disabled={busyKind === e.kind || (e.locked && e.enabled)} onChange={() => void toggle(e)} />
                          {e.enabled ? 'פעיל' : 'כבוי'}{e.locked && <span className="sec-muted"> (לא ניתן לכבות)</span>}
                        </label>
                      </td>
                      <td data-label="נוסח">{e.published ? <>מותאם (גרסה {e.published.id})</> : <span className="sec-muted">נוסח מקורי</span>}</td>
                      <td data-label="30 ימים אחרונים" className="sec-muted">{counts || '—'}</td>
                      <td className="sec-actions">
                        <button type="button" className="sec-btn" aria-expanded={selected === e.kind} onClick={() => setSelected(selected === e.kind ? null : e.kind)}>
                          <i className="bi bi-pencil" aria-hidden="true" />עריכה
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.some((e) => e.kind === selected) && <Editor kind={selected!} onChanged={load} />}
          </section>
        );
      })}

      <Suppression onDone={load} />
    </div>
  );
}

function Editor({ kind, onChanged }: { kind: string; onChanged: () => void }) {
  const [d, setD] = useState<KindDetail | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<{ subject: string; html: string; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'alert'; text: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    api(`/admin/mail/kinds/${kind}`).then((x: KindDetail) => { setD(x); setSubject(x.current.subject); setBody(x.current.body); })
      .catch(() => setMsg({ tone: 'alert', text: 'לא הצלחנו לטעון את המייל.' }));
  }, [kind]);
  useEffect(load, [load]);

  // Preview with sample values, a moment after typing stops.
  useEffect(() => {
    if (!d) return;
    const t = setTimeout(() => {
      api('/admin/mail/preview', { method: 'POST', body: JSON.stringify({ kind, subject, body }) })
        .then((p) => setPreview(p)).catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [d, kind, subject, body]);

  const insert = (before: string, after = '', placeholder = '') => {
    const el = bodyRef.current;
    if (!el) return;
    const s = el.selectionStart; const e = el.selectionEnd;
    const sel = body.slice(s, e) || placeholder;
    const next = body.slice(0, s) + before + sel + after + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + before.length, s + before.length + sel.length); });
  };
  const atLineStart = (prefix: string) => {
    const el = bodyRef.current; if (!el) return;
    const s = el.selectionStart; const lineStart = body.lastIndexOf('\n', s - 1) + 1;
    setBody(body.slice(0, lineStart) + prefix + body.slice(lineStart));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + prefix.length, s + prefix.length); });
  };

  const linkParams = useMemo(() => d?.params.filter((p) => p.link) ?? [], [d]);
  const errors = preview?.errors ?? [];
  const dirty = !!d && (subject !== d.current.subject || body !== d.current.body);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); load(); onChanged(); }
    catch (e) { setMsg({ tone: 'alert', text: `${label} לא הצליח: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };
  const save = (publish: boolean) => run(publish ? 'הפרסום' : 'השמירה',
    () => api(`/admin/mail/kinds/${kind}/versions`, { method: 'POST', body: JSON.stringify({ subject, body, publish }) }),
    publish ? 'נשמר ופורסם. מעכשיו זה הנוסח שנשלח.' : 'נשמר כטיוטה. עדיין נשלח הנוסח הקודם.');
  const publishVersion = (id: string) => run('הפרסום', () => api(`/admin/mail/kinds/${kind}/versions/${id}/publish`, { method: 'POST' }), `גרסה ${id} פורסמה.`);
  const reset = () => { if (window.confirm('לחזור לנוסח המקורי? הגרסאות שנשמרו לא נמחקות.')) void run('החזרה', () => api(`/admin/mail/kinds/${kind}/reset`, { method: 'POST' }), 'חזרנו לנוסח המקורי.'); };
  const testSend = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/admin/mail/test', { method: 'POST', body: JSON.stringify({ kind, subject, body }) });
      setMsg(r.status === 'sent' ? { tone: 'ok', text: 'נשלח מייל בדיקה לכתובת שלך, עם ערכים לדוגמה.' }
        : r.status === 'off' ? { tone: 'alert', text: 'שליחת מיילים כבויה בשרת, אז הבדיקה לא נשלחה.' }
        : r.status === 'suppressed' ? { tone: 'alert', text: 'הכתובת שלך חסומה (מייל קודם חזר). אפשר לשחרר אותה למטה.' }
        : { tone: 'alert', text: 'הבדיקה לא נשלחה.' });
    } catch (e) { setMsg({ tone: 'alert', text: `הבדיקה לא נשלחה: ${(e as Error).message}` }); }
    finally { setBusy(false); }
  };

  if (!d) return <div className="mt-3">{msg ? <Chip tone="alert">{msg.text}</Chip> : <span className="sec-muted">טוען…</span>}</div>;

  return (
    <div className="mt-3 pt-3 border-top" data-testid="mail-editor">
      <h3 className="fs-5">{d.label}</h3>
      <p className="sec-muted">{d.when}</p>
      <div className="row g-3">
        <div className="col-lg-6">
          <label className="form-label fw-bold" htmlFor="mail-subject">נושא</label>
          <input id="mail-subject" className="form-control" value={subject} maxLength={d.limits.subject} onChange={(e) => setSubject(e.target.value)} />

          <div className="d-flex flex-wrap gap-1 mt-3 mb-1" role="toolbar" aria-label="עיצוב">
            <button type="button" className="board-pill board-pill--small" onClick={() => insert('**', '**', 'טקסט מודגש')}><i className="bi bi-type-bold" aria-hidden="true" /> מודגש</button>
            <button type="button" className="board-pill board-pill--small" onClick={() => atLineStart('# ')}>כותרת</button>
            <button type="button" className="board-pill board-pill--small" onClick={() => atLineStart('- ')}><i className="bi bi-list-ul" aria-hidden="true" /> רשימה</button>
            <button type="button" className="board-pill board-pill--small" onClick={() => insert('[', `](${linkParams[0] ? `{{${linkParams[0].name}}}` : 'https://'})`, 'טקסט הקישור')}><i className="bi bi-link-45deg" aria-hidden="true" /> קישור</button>
            {linkParams.length > 0 && (
              <button type="button" className="board-pill board-pill--small" onClick={() => insert(`\n[[כפתור: `, ` | {{${linkParams[0].name}}}]]\n`, 'טקסט הכפתור')}>כפתור</button>
            )}
            <select className="form-select form-select-sm w-auto" aria-label="הוספת פרמטר" value=""
              onChange={(e) => { if (e.target.value) insert(`{{${e.target.value}}}`); }}>
              <option value="">+ פרמטר…</option>
              {d.params.map((p) => <option key={p.name} value={p.name}>{p.label} ({`{{${p.name}}}`})</option>)}
            </select>
          </div>
          <label className="form-label fw-bold visually-hidden" htmlFor="mail-body">תוכן</label>
          <textarea id="mail-body" ref={bodyRef} className="form-control" dir="rtl" rows={14} value={body} maxLength={d.limits.body}
            onChange={(e) => setBody(e.target.value)} style={{ fontFamily: 'inherit' }} />
          <Help label="איך כותבים">
            <ul className="mb-0">
              <li>שורה ריקה מתחילה פסקה חדשה. <span dir="ltr">**טקסט**</span> מודגש. שורה שמתחילה ב-<span dir="ltr">"# "</span> היא כותרת, וב-<span dir="ltr">"- "</span> פריט ברשימה.</li>
              <li>קישור: <span dir="ltr">[טקסט](https://…)</span> או לפרמטר קישור. כפתור בשורה משלו: <span dir="ltr">[[כפתור: טקסט | {'{{jobLink}}'}]]</span>.</li>
              <li>פרמטרים כמו <span dir="ltr">{'{{firstName}}'}</span> מתמלאים בשליחה. הערכים מוצגים כמו שהם, אף פעם לא כקוד.</li>
              {d.required.length > 0 && <li>חובה להשאיר: {d.required.map((r) => <span key={r} dir="ltr">{`{{${r}}} `}</span>)}</li>}
            </ul>
          </Help>
          {errors.length > 0 && (
            <ul className="mt-2 mb-0" role="alert" data-testid="mail-errors">{errors.map((e) => <li key={e}><Chip tone="alert">{errorText(e)}</Chip></li>)}</ul>
          )}
          <div className="d-flex flex-wrap gap-2 mt-3">
            <button type="button" className="sec-btn sec-btn--primary" disabled={busy || errors.length > 0} onClick={() => void save(true)}><i className="bi bi-send-check" aria-hidden="true" />שמירה ופרסום</button>
            <button type="button" className="sec-btn" disabled={busy || errors.length > 0 || !dirty} onClick={() => void save(false)}>שמירה כטיוטה</button>
            <button type="button" className="sec-btn" disabled={busy || errors.length > 0} onClick={() => void testSend()}><i className="bi bi-envelope" aria-hidden="true" />שליחת בדיקה אליי</button>
            <button type="button" className="sec-btn" disabled={busy || !d.current.versionId} onClick={reset}>חזרה לנוסח המקורי</button>
          </div>
          {msg && <p role="status" className="mt-2"><Chip tone={msg.tone}>{msg.text}</Chip></p>}
        </div>

        <div className="col-lg-6">
          <div className="fw-bold mb-1">תצוגה מקדימה (ערכים לדוגמה)</div>
          <div className="border rounded p-2 mb-1 small"><span className="sec-muted">נושא: </span>{preview?.subject ?? ''}</div>
          <iframe title="תצוגה מקדימה של המייל" sandbox="" srcDoc={preview?.html ?? ''} style={{ width: '100%', height: 460, border: '1px solid #ccc', borderRadius: 8, background: '#f6f6f6' }} />
        </div>
      </div>

      <h4 className="fs-6 mt-4">גרסאות</h4>
      {d.versions.length === 0 ? <p className="sec-muted">עוד לא נשמרה גרסה. נשלח הנוסח המקורי.</p> : (
        <table className="sec-table sec-table--stack">
          <thead><tr><th scope="col">גרסה</th><th scope="col">נשמרה</th><th scope="col">נושא</th><th scope="col"><span className="visually-hidden">פעולות</span></th></tr></thead>
          <tbody>
            {d.versions.map((v) => (
              <tr key={v.id}>
                <td>{v.id} {v.isPublished && <Chip tone="ok">בשימוש</Chip>}</td>
                <td data-label="נשמרה">{fmtDateTime(v.createdAt)} <span className="sec-muted">· {v.createdBy}</span></td>
                <td data-label="נושא">{v.subject}</td>
                <td className="sec-actions">
                  <button type="button" className="sec-btn" onClick={() => { setSubject(v.subject); setBody(v.body); }}>טעינה לעורך</button>
                  {!v.isPublished && <button type="button" className="sec-btn" disabled={busy} onClick={() => void publishVersion(v.id)}>פרסום</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Suppression({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'alert' | 'muted'; text: string } | null>(null);
  const submit = async () => {
    setMsg(null);
    try {
      const r = await api('/admin/mail/suppressions/remove', { method: 'POST', body: JSON.stringify({ email }) });
      setMsg(r.removed ? { tone: 'ok', text: 'הכתובת שוחררה. מיילים יישלחו אליה שוב.' } : { tone: 'muted', text: 'הכתובת לא הייתה חסומה.' });
      setEmail(''); onDone();
    } catch (e) { setMsg({ tone: 'alert', text: (e as Error).message }); }
  };
  return (
    <section className="sec-card" aria-labelledby="mail-supp-h">
      <div className="sec-card__head"><h2 id="mail-supp-h">כתובות חסומות</h2></div>
      <p className="sec-muted">כשמייל חוזר (הכתובת לא קיימת) או מסומן כספאם, האתר מפסיק לשלוח לכתובת הזאת. הרשימה שמורה כקוד מוצפן, לא ככתובות. אם מישהו תיקן את תיבת הדואר, אפשר לשחרר אותה כאן.</p>
      <form className="d-flex flex-wrap gap-2 align-items-end" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label className="form-label" htmlFor="mail-supp-email">כתובת מייל</label>
          <input id="mail-supp-email" type="email" dir="ltr" className="form-control" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <button type="submit" className="sec-btn">שחרור</button>
      </form>
      {msg && <p role="status" className="mt-2"><Chip tone={msg.tone}>{msg.text}</Chip></p>}
    </section>
  );
}
