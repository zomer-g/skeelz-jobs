import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { languageStore } from '../../store/Language.store';
import { Language } from '../../i18n/General.enums';

/**
 * Any path the app does not have. The server answers it with 404 too (server/src/seo/seoPure.ts).
 * Someone who lands here often came from an old or mistyped link (a campaign, a saved bookmark), so the page offers
 * the way on: all open jobs, the latest three (public API, nothing personal), and back.
 */
type Recent = { id: string; title: string; companyName: string; location: { city?: string } | null };

const TEXT = {
  he: {
    title: 'הדף לא נמצא',
    lead: 'ייתכן שהקישור ישן, שיש בו טעות, או שהדף כבר לא קיים.',
    jobs: 'לכל המשרות הפתוחות',
    back: 'חזרה לדף הקודם',
    recent: 'משרות שנפתחו לאחרונה',
    code: 'שגיאה 404',
  },
  en: {
    title: 'Page not found',
    lead: 'The link may be old or mistyped, or the page no longer exists.',
    jobs: 'See all open jobs',
    back: 'Go back',
    recent: 'Recently opened jobs',
    code: 'Error 404',
  },
};

/** A folder with a sad page and a broken link: the same line style as the board's "no results" picture. */
const Illustration = () => (
  <svg className="not-found__art" viewBox="0 0 240 190" role="presentation" aria-hidden="true" focusable="false">
    <ellipse cx="120" cy="176" rx="84" ry="7" fill="#e9e1e4" />
    <rect x="58" y="34" width="108" height="92" rx="12" fill="#f9b3ad" transform="rotate(-7 112 80)" />
    <rect x="72" y="22" width="96" height="104" rx="12" fill="#fff" stroke="#e5484d" strokeWidth="3.5" transform="rotate(6 120 74)" />
    <g transform="rotate(6 120 74)">
      <circle cx="107" cy="48" r="3.5" fill="#e5484d" /><circle cx="133" cy="48" r="3.5" fill="#e5484d" />
      <path d="M106 70 q14 -11 28 0" stroke="#e5484d" strokeWidth="3.5" strokeLinecap="round" fill="none" />
    </g>
    <path d="M42 84 h46 l12 12 h98 a8 8 0 0 1 8 8 v58 a8 8 0 0 1 -8 8 h-156 a8 8 0 0 1 -8 -8 v-70 a8 8 0 0 1 8 -8 z"
      fill="#fff" stroke="#e5484d" strokeWidth="3.5" strokeLinejoin="round" />
    <g stroke="#cd0077" strokeWidth="4" strokeLinecap="round" fill="none">
      <path d="M86 132 l-10 10 a10 10 0 0 0 14 14 l10 -10" />
      <path d="M126 128 l10 -10 a10 10 0 0 1 14 14 l-10 10" />
      <path d="M104 126 l-4 -8" /><path d="M112 124 l2 -9" /><path d="M118 132 l9 -3" />
    </g>
  </svg>
);

const NotFoundPage: React.FC = () => {
  const { currentLanguage } = languageStore();
  const t = currentLanguage === Language.HEBREW ? TEXT.he : TEXT.en;
  const navigate = useNavigate();
  const [recent, setRecent] = useState<Recent[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => { document.title = `${t.title} | SKEELZ`; }, [t.title]);
  useEffect(() => {
    // Only after moving inside the site (react-router's history index): "back" never sends a visitor away from it.
    setCanGoBack(Number((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0);
    const ctrl = new AbortController();
    fetch('/api/public/v1/jobs?limit=3', { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (Array.isArray(b?.data)) setRecent(b.data.slice(0, 3)); })
      .catch(() => undefined); // the page stands without them
    return () => ctrl.abort();
  }, []);

  return (
    <section className="not-found" aria-labelledby="not-found-title">
      <Illustration />
      <p className="not-found__code">{t.code}</p>
      <h1 id="not-found-title" className="not-found__title font-EzerRegularLoft">{t.title}</h1>
      <p className="not-found__lead font-RubikRegular">{t.lead}</p>
      <div className="not-found__actions">
        <Link to="/" className="not-found__primary font-RubikMedium">{t.jobs}</Link>
        {canGoBack && (
          <button type="button" className="not-found__secondary font-RubikRegular" onClick={() => navigate(-1)}>{t.back}</button>
        )}
      </div>
      {recent.length > 0 && (
        <nav className="not-found__recent" aria-labelledby="not-found-recent">
          <h2 id="not-found-recent" className="not-found__recent-title font-RubikMedium">{t.recent}</h2>
          <ul>
            {recent.map((j) => (
              <li key={j.id}>
                <Link to={`/job/${j.id}`} className="not-found__job">
                  <span className="not-found__job-title font-RubikMedium">{j.title}</span>
                  <span className="not-found__job-meta font-RubikRegular">
                    {[j.companyName, j.location?.city].filter(Boolean).join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
};

export default NotFoundPage;
