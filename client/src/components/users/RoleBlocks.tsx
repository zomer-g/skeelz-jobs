// Blocking a role of an account, one by one (owner, 24.11.2026; admins only): candidate, employer, staff role. A blocked
// role stays on the account (its data stays) but opens nothing; blocking signs the person out everywhere, and they sign
// in again with the roles still open to them. Used on the staff screen (per staff member + "find an account by email"
// for employers, who are on no list) and on the candidates screen. Server: server/src/controllers/roleBlocksController.ts.
import { useEffect, useState } from 'react';
import useModalStore from '../../store/Modal.store';
import useAuthStore from '../../store/Auth.store';
import { ROLE_LABELS, UserRole, userHasRole } from '../../i18n/General.enums';
import { Chip, api } from '../security/ui';

export type BlockKind = 'user' | 'employer' | 'staff';
export type BlocksView = { id: string; roles: BlockKind[]; staffRole: string | null; blocked: BlockKind[]; active: boolean };

const KINDS: BlockKind[] = ['user', 'employer', 'staff'];
export const KIND_LABELS: Record<BlockKind, string> = { user: 'מועמד/ת', employer: 'מעסיק', staff: 'צוות' };

/** Is the signed-in user an admin (the only role that sees this control)? */
export const useIsAdmin = () => userHasRole(useAuthStore((s) => s.user) as any, UserRole.ADMIN);

/** The three toggles for one account. `who` names it in the confirmations (email for staff, the name for a candidate). */
export function RoleBlocksPanel({ id, who, initial, onChanged }: { id: string; who: string; initial?: BlocksView; onChanged?: () => void }) {
  const [v, setV] = useState<BlocksView | null>(initial ?? null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!initial) api(`/admin/role-blocks/${id}`).then(setV).catch((e) => setErr((e as Error).message));
  }, [id, initial]);

  const toggle = async (kind: BlockKind, blocked: boolean) => {
    const label = kind === 'staff' && v?.staffRole ? ROLE_LABELS[v.staffRole] ?? KIND_LABELS.staff : KIND_LABELS[kind];
    const text = blocked
      ? `לחסום את ${who} בתפקיד "${label}"? כל החיבורים שלו ייסגרו עכשיו. הוא יוכל להיכנס שוב רק בתפקידים שנשארו פתוחים.`
      : `לבטל את החסימה של ${who} בתפקיד "${label}"?`;
    if (!window.confirm(text)) return;
    setBusy(true); setErr('');
    try {
      setV(await api(`/admin/role-blocks/${id}/${kind}`, { method: 'PUT', body: JSON.stringify({ blocked }) }));
      onChanged?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (err && !v) return <p dir="rtl" className="p-3 text-danger" role="alert">{err}</p>;
  if (!v) return <p dir="rtl" className="p-3" aria-busy="true">טוען…</p>;
  return (
    <div dir="rtl" className="p-3" data-testid="role-blocks">
      <p className="mb-2">חסימה לפי תפקיד: התפקיד נשאר בחשבון (והנתונים שלו נשמרים), אבל לא נפתח בו כלום. חסימה סוגרת מיד
        את כל החיבורים; הכניסה הבאה תהיה בתפקידים שנשארו פתוחים. אפשר לחסום גם תפקיד שעוד אין לו, כדי שלא יוכל להוסיף אותו.</p>
      {err && <p className="text-danger" role="alert">{err}</p>}
      <ul className="list-unstyled mb-0">
        {KINDS.map((k) => {
          const held = v.roles.includes(k);
          const blocked = v.blocked.includes(k);
          const label = k === 'staff' && v.staffRole ? `${KIND_LABELS.staff} (${ROLE_LABELS[v.staffRole] ?? v.staffRole})` : KIND_LABELS[k];
          return (
            <li key={k} className="d-flex align-items-center justify-content-between gap-2 border-bottom py-2">
              <span>
                <b>{label}</b>{' '}
                {blocked ? <Chip tone="alert">חסום</Chip> : held ? <Chip tone="ok">פעיל</Chip> : <Chip tone="muted">אין לו את התפקיד</Chip>}
              </span>
              <button type="button" className={`sec-btn ${blocked ? '' : 'sec-btn--danger'}`} disabled={busy}
                aria-label={`${blocked ? 'ביטול חסימה' : 'חסימה'}: ${label} — ${who}`} onClick={() => void toggle(k, !blocked)}>
                {blocked ? 'ביטול חסימה' : 'חסימה'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A small button that opens the panel in the site's modal (candidates screen, staff screen). */
export function RoleBlocksButton({ id, who, blocked, onChanged }: { id: string; who: string; blocked?: string[]; onChanged?: () => void }) {
  const { initModal } = useModalStore();
  const n = blocked?.length ?? 0;
  return (
    <button type="button" className={`sec-chip sec-chip--${n ? 'alert' : 'muted'} border-0`} aria-label={`חסימת תפקידים: ${who}${n ? ` (${n} חסומים)` : ''}`}
      onClick={() => initModal({ active: true, modalTitle: `חסימת תפקידים: ${who}`, modalBody: <RoleBlocksPanel id={id} who={who} onChanged={onChanged} /> })}>
      {n ? `חסום: ${blocked!.map((b) => KIND_LABELS[b as BlockKind] ?? b).join(', ')}` : 'תפקידים'}
    </button>
  );
}

/** Find any account by its email (an employer is on no staff list) and show its toggles. Admins only. */
export function RoleBlocksLookup() {
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<BlocksView | null>(null);
  const [shownFor, setShownFor] = useState('');
  const [err, setErr] = useState('');
  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = email.trim();
    if (!q) return;
    setErr(''); setFound(null);
    try { setFound(await api(`/admin/role-blocks?email=${encodeURIComponent(q)}`)); setShownFor(q); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <div>
      <form className="d-flex gap-2 flex-wrap align-items-end" onSubmit={find}>
        <label className="sec-field flex-grow-1 mb-0"><span>מייל של החשבון</span>
          <input className="form-control" type="email" dir="ltr" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" className="sec-btn sec-btn--primary" disabled={!email.trim()}>חיפוש</button>
      </form>
      {err && <p className="text-danger mt-2" role="alert">{err === 'No such account' ? 'אין חשבון עם המייל הזה.' : err}</p>}
      {found && <RoleBlocksPanel key={found.id} id={found.id} who={shownFor} initial={found} />}
    </div>
  );
}
