// Employer job posting (open / account_required; docs/employers.md) — on the settings screen's job-posting section, with
// its own save button (owner, 23.11.2026: it was saved together with the ways to apply).
import React, { useEffect, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import CircularLoader from '../common/CircularLoader';
import SettingsService, { EmployerPostingMode } from '../../services/api/Settings.service';
import useToastStore from '../../store/Toast.store';
import { isString } from '../../utils/utils';
import { Radio } from '../applyPolicy/ApplyPolicySettings';
import SaveButton from './SaveButton';

const EmployerPostingSettings: React.FC = () => {
  const te = i18n.getTranslations().Employers;
  const { showToast } = useToastStore();
  const [posting, setPosting] = useState<EmployerPostingMode | null>(null);
  const [loaded, setLoaded] = useState<EmployerPostingMode | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await SettingsService.getInstance().getEmployerPosting();
      if (isString(r)) { setFailed(true); return; }
      setPosting(r.mode); setLoaded(r.mode);
    })();
  }, []);

  const save = async () => {
    if (!posting) return;
    setSaving(true);
    const r = await SettingsService.getInstance().updateEmployerPosting(posting);
    setSaving(false);
    if (isString(r)) { showToast(r, 'error'); return; }
    setLoaded(r.mode);
    showToast(te.PostingSaved, 'success');
  };

  if (failed) return <p role="alert" className="sec-note">{te.PostingLoadFailed}</p>;
  if (!posting) return <div className="p-5"><CircularLoader /></div>;

  return (
    <div className="apply-settings">
      <fieldset className="apply-settings__group" aria-describedby="apply-settings-posting-hint">
        {/* The card heading says it; the legend stays for screen readers. */}
        <legend className="visually-hidden">{te.PostingLabel}</legend>
        <div id="apply-settings-posting-hint" className="font-RubikSmall text-color-dark-grey mb-1">{te.PostingHint}</div>
        {([['open', te.PostingOpen, te.PostingOpenHint], ['account_required', te.PostingRequired, te.PostingRequiredHint]] as const).map(([m, label, hint]) => (
          <div key={m} className="apply-settings__option">
            <Radio name="apply-settings-posting" value={m} label={label} describedBy={`apply-settings-posting-${m}-hint`}
              checked={posting === m} onChange={() => setPosting(m)} />
            <div id={`apply-settings-posting-${m}-hint`} className="font-RubikSmall text-color-dark-grey apply-settings__option-hint">{hint}</div>
          </div>
        ))}
      </fieldset>
      <div className="d-flex align-items-center gap-3 mt-3 flex-wrap">
        <SaveButton onClick={save} disabled={saving || posting === loaded} testId="employer-posting-save" />
        {posting !== loaded && <span className="sec-muted">שינוי שלא נשמר</span>}
      </div>
    </div>
  );
};

export default EmployerPostingSettings;
