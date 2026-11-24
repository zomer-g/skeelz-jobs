// Marketing mail state of a candidate on the staff candidates list (/users-management): the state, its history, and
// for content managers / admins a removal on the person's request. Nobody here can mark someone as "agreed": only
// the person can (personal area). Server: GET /api/admin/users/:id/marketing (every staff role, counted and logged
// like any candidate shown), POST /api/admin/users/:id/marketing-optout (content managers), docs/marketing-consent.md.
import { useEffect, useState } from 'react';
import useModalStore from '../../store/Modal.store';
import { api, fmtDateTime } from '../security/ui';

export type MarketingStatusValue = 'agreed' | 'not_agreed' | 'removed' | 'unknown';
export const MARKETING_LABELS: Record<MarketingStatusValue, string> = {
  agreed: 'אישר/ה', not_agreed: 'לא אישר/ה', removed: 'ביקש/ה הסרה', unknown: 'לא ידוע',
};
const TONE: Record<MarketingStatusValue, string> = { agreed: 'ok', not_agreed: 'muted', removed: 'alert', unknown: 'muted' };
const SOURCE_LABELS: Record<string, string> = {
  signup: 'בהרשמה', apply: 'בהגשת מועמדות', personal_area: 'באזור האישי', candidate_role_added: 'בהוספת תפקיד מועמד',
  unsubscribe_link: 'בקישור ההסרה במייל', staff_on_request: 'צוות, לבקשת האדם', complaint: 'סימן מייל כספאם',
};
const VIA_LABELS: Record<string, string> = { link: 'קישור הסרה', personal_area: 'האזור האישי', staff: 'צוות, לבקשתו', complaint: 'תלונת ספאם' };

interface View {
  status: MarketingStatusValue; at: string | null; source: string | null;
  removal: { at: string; via: string } | null;
  history: { at: string; marketing: boolean; source: string }[];
}

function History({ id, readOnly, onChanged }: { id: string; readOnly: boolean; onChanged: () => void }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/admin/users/${id}/marketing`).then(setV).catch((e) => setErr((e as Error).message));
  }, [id]);
  const remove = async () => {
    if (!window.confirm('לרשום שהאדם ביקש להסיר אותו מדיוור שיווקי? רק הוא עצמו יוכל לאשר דיוור שוב.')) return;
    setBusy(true);
    try {
      await api(`/admin/users/${id}/marketing-optout`, { method: 'POST' });
      setV(await api(`/admin/users/${id}/marketing`));
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (err) return <p dir="rtl" className="p-3 text-danger" role="alert">{err}</p>;
  if (!v) return <p dir="rtl" className="p-3">טוען…</p>;
  return (
    <div dir="rtl" className="p-4 min-h-20vh max-h-60vh overflow-auto" data-testid="marketing-history">
      <p className="mb-2"><strong>מצב: </strong><span className={`sec-chip sec-chip--${TONE[v.status]}`}>{MARKETING_LABELS[v.status]}</span></p>
      {v.removal && <p className="mb-2">בקשת הסרה: {fmtDateTime(v.removal.at)} ({VIA_LABELS[v.removal.via] ?? v.removal.via}). רק האדם עצמו יכול לאשר שוב.</p>}
      <h3 className="fs-6 mt-3">היסטוריה</h3>
      {v.history.length === 0 ? <p className="text-muted">לא נשאל/ה (חשבון ותיק או שהועתק מהאתר הקודם).</p> : (
        <ul className="ps-0" style={{ listStyle: 'none' }}>
          {v.history.map((h, i) => (
            <li key={i} className="mb-1">{fmtDateTime(h.at)}: {h.marketing ? 'אישר/ה' : 'לא אישר/ה / הוסר/ה'} <span className="text-muted">({SOURCE_LABELS[h.source] ?? h.source})</span></li>
          ))}
        </ul>
      )}
      {!readOnly && v.status !== 'removed' && (
        <button type="button" className="sec-btn sec-btn--danger mt-2" disabled={busy} onClick={() => void remove()} data-testid="marketing-remove">
          רישום בקשת הסרה מדיוור
        </button>
      )}
    </div>
  );
}

/** The state as a small button; opens the history. */
export default function MarketingStatus({ id, name, value, readOnly, onChanged }: {
  id: string; name: string; value?: { status: MarketingStatusValue } | null; readOnly: boolean; onChanged: () => void;
}) {
  const { initModal } = useModalStore();
  const status = value?.status ?? 'unknown';
  return (
    <button type="button" className={`sec-chip sec-chip--${TONE[status]} border-0`} aria-label={`דיוור שיווקי: ${MARKETING_LABELS[status]}. היסטוריה: ${name}`}
      onClick={() => initModal({ active: true, modalTitle: `דיוור שיווקי: ${name}`, modalBody: <History id={id} readOnly={readOnly} onChanged={onChanged} /> })}>
      {MARKETING_LABELS[status]}
    </button>
  );
}
