import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { languageStore } from '../../store/Language.store';
import { Language } from '../../i18n/General.enums';

/** Any path the app does not have. The server answers it with 404 too (server/src/seo/seoPure.ts). */
const NotFoundPage: React.FC = () => {
  const { currentLanguage } = languageStore();
  const he = currentLanguage === Language.HEBREW;
  const title = he ? 'הדף לא נמצא' : 'Page not found';
  useEffect(() => { document.title = `${title} | SKEELZ`; }, [title]);
  return (
    <div className="container py-5 text-center">
      <h1 className="font-EzerRegularLoft mb-3">{title}</h1>
      <p className="mb-4">{he ? 'ייתכן שהקישור ישן או שיש בו טעות.' : 'The link may be old or mistyped.'}</p>
      <Link to="/" className="btn bg-color-purple-btn text-white rounded-pill px-4">
        {he ? 'לכל המשרות הפתוחות' : 'See all open jobs'}
      </Link>
    </div>
  );
};

export default NotFoundPage;
