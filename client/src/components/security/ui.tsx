// Shared pieces of the staff screens (security, staff users, API keys). Styles: `.sec-*` in App.scss.
// Status is always text + icon (never colour alone); dialogs trap focus, close on Escape and return focus.
import React, { useEffect, useId, useRef } from 'react';

export const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body.data;
};

/** 12.11.2026 */
export const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '—';
/** 12.11.2026, 12:50 */
export const fmtDateTime = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('he', { numeric: 'auto' }) : null;
/** "לפני 5 דקות", "אתמול"; older than a week → the date. */
export const relTime = (s: string | null | undefined, now = Date.now()) => {
  if (!s) return '—';
  const diff = (new Date(s).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf || abs > 7 * 86400) return fmtDate(s);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
};

export type Tone = 'ok' | 'warn' | 'alert' | 'muted';
const ICON: Record<Tone, string> = { ok: 'bi-check-circle-fill', warn: 'bi-exclamation-circle-fill', alert: 'bi-x-octagon-fill', muted: 'bi-dash-circle' };

export const Chip: React.FC<{ tone: Tone; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`sec-chip sec-chip--${tone}`}><i className={`bi ${ICON[tone]}`} aria-hidden="true" />{children}</span>
);

/** A collapsed "מה זה?" with the long explanation. */
export const Help: React.FC<{ children: React.ReactNode; label?: string }> = ({ children, label = 'מה זה?' }) => (
  <details className="sec-help">
    <summary><i className="bi bi-question-circle" aria-hidden="true" />{label}</summary>
    <div className="sec-help__body">{children}</div>
  </details>
);

/** used / allowed as a bar; amber from the alert line, red at the limit. */
export const Meter: React.FC<{ used: number; allowed: number; alertAt: number; label: string }> = ({ used, allowed, alertAt, label }) => {
  const pct = allowed > 0 ? Math.min(100, Math.round((used / allowed) * 100)) : 0;
  const tone = used >= allowed ? 'alert' : used >= alertAt ? 'warn' : 'ok';
  return (
    <div className={`sec-meter sec-meter--${tone}`}>
      <div className="sec-meter__bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={allowed} aria-valuenow={used}
        aria-valuetext={`${used} מתוך ${allowed}${tone === 'alert' ? ', הגיע למגבלה' : tone === 'warn' ? ', מעל סף ההתראה' : ''}`}>
        <div className="sec-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="sec-meter__text">{used}/{allowed}{tone === 'alert' ? ' ⛔' : tone === 'warn' ? ' ⚠' : ''}</span>
    </div>
  );
};

/** Modal dialog: labelled, focus trapped, Escape closes, focus returns to the opener. */
export const Dialog: React.FC<{ open: boolean; title: string; onClose: () => void; children: React.ReactNode }> = ({ open, title, onClose, children }) => {
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const first = boxRef.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const items = Array.from(boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'));
      if (!items.length) return;
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sec-dialog__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} className="sec-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} dir="rtl">
        <h2 id={`${id}-t`} className="sec-dialog__title">{title}</h2>
        {children}
      </div>
    </div>
  );
};
