// תנאי סף: before an application to a job with a threshold condition is sent, the candidate confirms they meet it.
// The server refuses the application without the confirmation (server/src/models/schemas/thresholdCondition.ts,
// 400 threshold_not_confirmed), so this dialog is the only way through, never a formality the client can skip.
// Usage: `const ok = await requestThresholdConfirm(text)` → true (confirmed) or false (cancelled / closed).
// Accessible: react-bootstrap Modal (focus kept inside, Escape closes = cancel, focus returns to the opener),
// labelled by its title and described by the condition; the checkbox has a real label and an announced error.
// It opens on top of the window that asked (CV choice, quick application): its own backdrop sits above that window
// (App.scss .threshold-backdrop / .threshold-dialog), so the window behind is dimmed instead of showing through.
import React, { useEffect, useRef, useState } from 'react';
import { Modal } from 'react-bootstrap';
import { i18n } from '../../i18n/I18n';

const EVENT = 'skeelz:threshold-confirm';
type Detail = { text: string; resolve: (confirmed: boolean) => void };

export function requestThresholdConfirm(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { text, resolve } }));
  });
}

const ThresholdConfirmDialog: React.FC = () => {
  const [req, setReq] = useState<Detail | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: Event) => { setChecked(false); setError(false); setReq((e as CustomEvent<Detail>).detail); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!req) return null;
  const t = i18n.getTranslations().Threshold;

  const finish = (confirmed: boolean) => { req.resolve(confirmed); setReq(null); };
  const submit = () => {
    if (!checked) { setError(true); boxRef.current?.focus(); return; }
    finish(true);
  };

  return (
    <Modal show onHide={() => finish(false)} onEntered={() => boxRef.current?.focus()} centered
      dir={i18n.isRTL() ? 'rtl' : 'ltr'} aria-labelledby="threshold-title" aria-describedby="threshold-intro threshold-text"
      className="threshold-dialog" backdropClassName="threshold-backdrop">
      <Modal.Header closeButton closeLabel={t.Cancel}>
        <Modal.Title id="threshold-title" as="h2" className="fs-5 font-RubikBold flex-grow-1">{t.DialogTitle}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p id="threshold-intro" className="font-RubikRegular mb-2">{t.DialogIntro}</p>
        {/* Plain text from the server (never HTML); line breaks kept. */}
        <blockquote id="threshold-text" dir="auto" className="threshold-text font-RubikMedium border-start border-4 ps-3 pe-3 py-2 mb-3"
          style={{ whiteSpace: 'pre-line', borderColor: '#5b3fd1', background: '#f5f2ff', borderRadius: 6 }}>
          {req.text}
        </blockquote>
        <div className="d-flex align-items-center gap-2">
          <input ref={boxRef} id="threshold-confirm" type="checkbox" className="form-check-input m-0 flex-shrink-0" checked={checked}
            aria-invalid={error || undefined} aria-describedby={error ? 'threshold-error' : undefined}
            onChange={(e) => { setChecked(e.target.checked); if (e.target.checked) setError(false); }} />
          <label htmlFor="threshold-confirm" className="form-check-label font-RubikMedium">{t.Confirm}</label>
        </div>
        {error && <p id="threshold-error" role="alert" className="text-danger fs-14 mt-2 mb-0">{t.ConfirmRequired}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => finish(false)}>{t.Cancel}</button>
        <button type="button" className="btn btn-dark rounded-pill px-4" onClick={submit}>{t.Submit}</button>
      </Modal.Footer>
    </Modal>
  );
};

export default ThresholdConfirmDialog;
