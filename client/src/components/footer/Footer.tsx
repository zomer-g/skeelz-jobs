import React from 'react';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import { analyticsEnabled, reopenConsent } from '../../utils/analytics';
import { i18n } from '../../i18n/I18n';
import InstallAppLink, { useInstallAvailable } from '../pwa/InstallApp';

// Same frame as the board header and the job cards (`.board-frame`, App.scss).
// The privacy policy and the accessibility statement links are required — keep them.
const NEW_TAB_NOTE = '(נפתח בחלון חדש)';

const InstallAppItem: React.FC = () => {
    if (!useInstallAvailable()) return null;
    return <li><InstallAppLink className="board-footer__link board-footer__link--button" /></li>;
};

const Footer: React.FC = () => {
    const translations = i18n.getTranslations();

    return (
        <footer className="board-footer">
            <div className="container">
                <div className="board-frame board-footer__inner">
                    <a className="board-footer__logo" href={ClientRoutes.MainPage}>
                        <img src="/images/logo.svg" alt="SKEELZ" className="logo" />
                    </a>

                    <nav aria-label="קישורים">
                        <ul className="board-footer__links">
                            <li>
                                <a className="board-footer__link board-footer__link--employer" href={ClientRoutes.PostJob}
                                    aria-label={translations.EmployerForm.HeaderButtonLabel}>
                                    {translations.EmployerForm.HeaderButton}
                                </a>
                            </li>
                            <li>
                                <a className="board-footer__link" href={ClientRoutes.Privacy}>
                                    מדיניות פרטיות
                                </a>
                            </li>
                            <li>
                                <a className="board-footer__link" href={ClientRoutes.Developers}>
                                    API ו-MCP למפתחים
                                </a>
                            </li>
                            {/* Shown only where the site can be installed and is not already (docs/pwa.md). */}
                            <InstallAppItem />
                            <li>
                                <a
                                    className="board-footer__link"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    href="https://www.skeelz.co.il/%d7%94%d7%a6%d7%94%d7%a8%d7%aa-%d7%a0%d7%92%d7%99%d7%a9%d7%95%d7%aa/"
                                >
                                    הצהרת נגישות
                                    <span className="visually-hidden"> {NEW_TAB_NOTE}</span>
                                </a>
                            </li>
                            <li>
                                <a
                                    className="board-footer__link"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    href="https://www.skeelz.co.il/%d7%99%d7%a6%d7%99%d7%a8%d7%aa-%d7%a7%d7%a9%d7%a8/"
                                >
                                    יצירת קשר
                                    <span className="visually-hidden"> {NEW_TAB_NOTE}</span>
                                </a>
                            </li>
                        </ul>
                    </nav>
                </div>
            </div>
        </footer>
    );
};

export default Footer;
