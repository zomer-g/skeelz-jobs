// Cookie / measurement consent (Google Consent Mode v2). See docs/analytics.md.
// - Shown only when analytics is on for the site (GTM_ID / GA_ID) and the visitor has not chosen yet
//   (or chose more than CONSENT_MAX_AGE_DAYS ago), or when they reopen it from the footer.
// - Until they accept, Consent Mode stays "denied" (set by the server before GTM loads) and
//   utils/analytics.ts sends no events.
// - Accessible: a labelled region (not a modal, the page stays usable), two equal buttons,
//   focus goes to it when reopened and back to the footer link after choosing.
import React, { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { analyticsEnabled, CONSENT_EVENT, getConsent, setConsent } from '../../utils/analytics';

const ConsentBanner: React.FC = () => {
  useLanguageStore(); // re-render on language change
  const t = i18n.getTranslations().Consent;
  const isRTL = i18n.isRTL();
  const ids = useId();
  const [open, setOpen] = useState(() => analyticsEnabled() && !getConsent());
  const [reopened, setReopened] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onConsent = (e: Event) => {
      if ((e as CustomEvent).detail?.reopen) {
        returnFocus.current = document.activeElement as HTMLElement | null;
        setReopened(true);
        setOpen(true);
      }
    };
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, []);

  useEffect(() => {
    if (open && reopened) headingRef.current?.focus();
  }, [open, reopened]);

  if (!open || !analyticsEnabled()) return null;

  const choose = (analytics: boolean) => {
    setConsent(analytics);
    setOpen(false);
    setReopened(false);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back && document.contains(back)) back.focus();
  };

  const current = getConsent();

  return (
    <section
      role="region"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-body`}
      dir={isRTL ? 'rtl' : 'ltr'}
      className="position-fixed bottom-0 start-0 end-0 bg-white border-top border-2 border-dark shadow-lg p-3"
      style={{ zIndex: 2000 }}
    >
      <div className="mx-auto d-flex flex-column flex-md-row gap-3 align-items-md-center" style={{ maxWidth: 1100 }}>
        <div className="flex-grow-1">
          <h2 id={`${ids}-title`} ref={headingRef} tabIndex={-1} className="font-RubikBold fs-6 mb-1">{t.Title}</h2>
          <p id={`${ids}-body`} className="font-RubikRegular mb-1 fs-14">
            {t.Body}{' '}
            {current && <span>{current.analytics ? t.CurrentAccepted : t.CurrentRejected}</span>}
          </p>
          <a className="font-RubikMedium fs-14 text-color-purple" href={ClientRoutes.Privacy}>{t.MoreInfo}</a>
        </div>
        <div className="d-flex gap-2 flex-shrink-0">
          <button type="button" className="btn btn-dark rounded-pill px-4" onClick={() => choose(true)}>{t.Accept}</button>
          <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={() => choose(false)}>{t.Reject}</button>
        </div>
      </div>
    </section>
  );
};

export default ConsentBanner;
