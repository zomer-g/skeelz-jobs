// Before a signed-in candidate applies: if they never accepted the current terms, or never answered the marketing
// question, ask once (server/src/security/consent.ts applyConsent; the server refuses with 428 otherwise).
// Usage: `const answer = await requestApplyConsent({ needTerms, needMarketing })` → the fields to send, or null.
import React, { useEffect, useState } from 'react';
import { Modal } from 'react-bootstrap';
import { i18n } from '../../i18n/I18n';
import ConsentChecks, { ConsentValues } from './ConsentChecks';

export interface ApplyConsentNeed { needTerms: boolean; needMarketing: boolean }
export type ApplyConsentAnswer = { consent?: true; marketingConsent?: boolean };

const EVENT = 'skeelz:apply-consent';
type Detail = ApplyConsentNeed & { resolve: (a: ApplyConsentAnswer | null) => void };

export function requestApplyConsent(need: ApplyConsentNeed): Promise<ApplyConsentAnswer | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent<Detail>(EVENT, { detail: { ...need, resolve } }));
  });
}

const ApplyConsentDialog: React.FC = () => {
  const [req, setReq] = useState<Detail | null>(null);
  const [values, setValues] = useState<ConsentValues>({ consent: false, marketingConsent: false });
  const [error, setError] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { setValues({ consent: false, marketingConsent: false }); setError(false); setReq((e as CustomEvent<Detail>).detail); };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!req) return null;
  const t = i18n.getTranslations().Terms;

  const finish = (answer: ApplyConsentAnswer | null) => { req.resolve(answer); setReq(null); };
  const submit = () => {
    if (req.needTerms && !values.consent) { setError(true); return; }
    const a: ApplyConsentAnswer = {};
    if (req.needTerms) a.consent = true;
    if (req.needMarketing) a.marketingConsent = values.marketingConsent;
    finish(a);
  };

  return (
    <Modal show onHide={() => finish(null)} centered dir={i18n.isRTL() ? 'rtl' : 'ltr'} aria-labelledby="apply-consent-title">
      <Modal.Header closeButton closeLabel={t.Cancel}>
        <Modal.Title id="apply-consent-title" as="h2" className="fs-5 font-RubikBold flex-grow-1">{t.DialogTitle}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="font-RubikRegular">{req.needTerms ? t.DialogIntroTerms : t.DialogIntroMarketing}</p>
        <ConsentChecks idPrefix="apply-consent" audience="candidate" values={values} onChange={(v) => { setValues(v); if (v.consent) setError(false); }}
          showTerms={req.needTerms} showMarketing={req.needMarketing} termsError={error} />
      </Modal.Body>
      <Modal.Footer>
        <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => finish(null)}>{t.Cancel}</button>
        <button type="button" className="btn btn-dark rounded-pill px-4" onClick={submit}>{t.Continue}</button>
      </Modal.Footer>
    </Modal>
  );
};

export default ApplyConsentDialog;
