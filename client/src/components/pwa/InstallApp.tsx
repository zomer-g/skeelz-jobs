// "התקנת האפליקציה" (docs/pwa.md): Chrome / Edge / Android get the browser's own install dialog; iPhone / iPad get a
// short how-to (Safari has no install dialog). Hidden when the site is already open as the installed app, and on
// browsers that offer neither.
import React, { useState } from 'react';
import { Modal } from 'react-bootstrap';
import { InstallSource, isIos, promptInstall, trackIosHowTo, usePwaState } from '../../utils/pwa';

export const INSTALL_LABEL = 'התקנת האפליקציה';

/** Whether to show the option at all. */
export function useInstallAvailable(): boolean {
  const { canPrompt, installed } = usePwaState();
  if (installed) return false;
  return canPrompt || (isIos() && !installed);
}

/** Opens the install dialog (or the iOS how-to). Render <IosInstallHelp> next to it. */
export function useInstallAction(source: InstallSource) {
  const [iosHelp, setIosHelp] = useState(false);
  const run = async () => {
    if (await promptInstall(source)) return;
    if (isIos()) { trackIosHowTo(source); setIosHelp(true); }
  };
  return { run, iosHelp, closeIosHelp: () => setIosHelp(false) };
}

export const IosInstallHelp: React.FC<{ show: boolean; onClose: () => void }> = ({ show, onClose }) => (
  <Modal show={show} onHide={onClose} centered dir="rtl" aria-labelledby="ios-install-title">
    <Modal.Header closeButton closeLabel="סגירה">
      <Modal.Title id="ios-install-title" as="h2" className="fs-4">{INSTALL_LABEL} באייפון</Modal.Title>
    </Modal.Header>
    <Modal.Body>
      <ol className="ios-install-steps">
        <li>פותחים את האתר בדפדפן Safari.</li>
        <li>
          לוחצים על כפתור השיתוף <i className="bi bi-box-arrow-up" aria-hidden="true" />
          <span className="visually-hidden"> (ריבוע עם חץ למעלה)</span> בתחתית המסך.
        </li>
        <li>בוחרים „הוספה למסך הבית” ולוחצים „הוספה”.</li>
      </ol>
      <p className="mb-0">הסמל של SKEELZ יופיע במסך הבית, והאתר ייפתח כמו אפליקציה.</p>
    </Modal.Body>
    <Modal.Footer>
      <button type="button" className="board-pill board-pill--outline" onClick={onClose}>הבנתי</button>
    </Modal.Footer>
  </Modal>
);

/** The footer link. */
const InstallAppLink: React.FC<{ className?: string }> = ({ className }) => {
  const available = useInstallAvailable();
  const { run, iosHelp, closeIosHelp } = useInstallAction('footer');
  if (!available && !iosHelp) return null;
  return (
    <>
      <button type="button" className={className} onClick={run}>
        <i className="bi bi-phone" aria-hidden="true" />
        {INSTALL_LABEL}
      </button>
      <IosInstallHelp show={iosHelp} onClose={closeIosHelp} />
    </>
  );
};

export default InstallAppLink;
