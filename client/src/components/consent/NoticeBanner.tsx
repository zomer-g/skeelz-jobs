// A small notice at the bottom of every page: the site collects data (what people send in forms and technical
// data such as IP addresses). It asks for nothing; "הבנתי" hides it and the choice is remembered in localStorage
// (if storage is blocked it simply shows again next time).
// When analytics is on (GTM_ID / GA_ID) it also says the site measures use with Google Analytics cookies. Since
// 15.11.2026 that needs no consent (the owner's decision), so there is nothing to accept: only a close button.
// While shown, the page gets bottom padding so the footer links stay reachable.
import React, { useEffect, useId, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { analyticsEnabled } from '../../utils/analytics';

// v2: the text now includes measurement, so people who closed the old notice see it once more.
export const NOTICE_STORAGE_KEY = 'skeelz_notice_v2';

const dismissed = (): boolean => {
  try { return window.localStorage.getItem(NOTICE_STORAGE_KEY) === '1'; } catch { return false; }
};

/** Keeps the page's last lines above a fixed bottom bar while it is shown. */
export function useBottomBarPadding(ref: React.RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current || typeof ResizeObserver === 'undefined') return;
    const el = ref.current;
    const set = () => { document.body.style.paddingBottom = `${el.offsetHeight}px`; };
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => { ro.disconnect(); document.body.style.paddingBottom = ''; };
  }, [active, ref]);
}

const NoticeBanner: React.FC = () => {
  useLanguageStore(); // re-render on language change
  const t = i18n.getTranslations().Notice;
  const ids = useId();
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(() => !dismissed());
  useBottomBarPadding(ref, open);
  if (!open) return null;

  const close = () => {
    try { window.localStorage.setItem(NOTICE_STORAGE_KEY, '1'); } catch { /* storage blocked: just hide for now */ }
    setOpen(false);
  };

  return (
    <section ref={ref} role="region" aria-label={t.Region} dir={i18n.isRTL() ? 'rtl' : 'ltr'}
      className="position-fixed bottom-0 start-0 end-0 bg-white border-top border-dark shadow px-3 py-2"
      style={{ zIndex: 1030 }}>
      <div className="mx-auto d-flex flex-wrap align-items-center gap-2 justify-content-between" style={{ maxWidth: 1100 }}>
        <p id={`${ids}-text`} className="font-RubikRegular fs-14 m-0 flex-grow-1" style={{ minWidth: 0, flexBasis: '16rem' }}>
          {t.Text}{analyticsEnabled() ? <>{' '}{t.Analytics}</> : null}{' '}
          <a className="font-RubikMedium text-color-purple" href={ClientRoutes.Privacy}>{t.Link}</a>
        </p>
        <button type="button" className="btn btn-dark btn-sm rounded-pill px-4 flex-shrink-0" onClick={close}
          aria-describedby={`${ids}-text`}>{t.Ok}</button>
      </div>
    </section>
  );
};

export default NoticeBanner;
