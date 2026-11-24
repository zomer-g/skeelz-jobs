// A new version of the site was deployed while this page was open (the new service worker took over, docs/pwa.md).
// A small notice at the bottom; the page keeps working as it is until the visitor chooses to refresh.
import React, { useState } from 'react';
import { usePwaState } from '../../utils/pwa';

const UpdateNotice: React.FC = () => {
  const { updateReady } = usePwaState();
  const [dismissed, setDismissed] = useState(false);
  if (!updateReady || dismissed) return null;
  return (
    <div className="pwa-update" role="status" dir="rtl">
      <span>גרסה חדשה של האתר זמינה</span>
      <button type="button" className="pwa-update__refresh" onClick={() => window.location.reload()}>רענון</button>
      <button type="button" className="pwa-update__close" onClick={() => setDismissed(true)} aria-label="סגירה">
        <i className="bi bi-x-lg" aria-hidden="true" />
      </button>
    </div>
  );
};

export default UpdateNotice;
