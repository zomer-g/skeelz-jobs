// Personal area ("הפרטים שלי"): give or withdraw consent to marketing mail and updates about cooperations.
// Saved at once (PUT /users/me/marketing-consent, logged as user.marketing_consent_changed).
import React, { useEffect, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import { UserService } from '../../services/api/User.service';
import { isString } from '../../utils/utils';
import useToastStore from '../../store/Toast.store';

const MarketingConsentToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const t = i18n.getTranslations().Terms;
  const { showToast } = useToastStore();
  const [value, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    UserService.getInstance().getMe().then((me) => { if (!isString(me)) setValue(me.consent?.marketing === true); });
  }, []);
  if (value === null) return null;

  const change = async (next: boolean) => {
    setSaving(true);
    const r = await UserService.getInstance().setMarketingConsent(next);
    setSaving(false);
    if (isString(r)) { showToast(r, 'error'); return; }
    setValue(r.consent?.marketing === true);
    showToast(t.PersonalSaved, 'success');
  };

  return (
    <fieldset className={`border rounded-3 px-3 py-2 ${className}`}>
      <legend className="float-none w-auto px-1 mb-0 fs-6 font-RubikMedium">{t.PersonalTitle}</legend>
      <div className="d-flex align-items-start gap-2 fs-14 font-RubikRegular">
        <input className="form-check-input m-0 mt-1 flex-shrink-0" type="checkbox" id="me-marketing" checked={value}
          disabled={saving} aria-describedby="me-marketing-hint" onChange={(e) => change(e.target.checked)} />
        <label className="form-check-label" htmlFor="me-marketing">{t.Marketing}</label>
      </div>
      <p id="me-marketing-hint" className="small text-muted mb-0 mt-1">{t.PersonalHint}</p>
    </fieldset>
  );
};

export default MarketingConsentToggle;
