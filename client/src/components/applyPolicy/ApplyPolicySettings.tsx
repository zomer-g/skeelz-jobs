import React, { useEffect, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import CircularLoader from '../common/CircularLoader';
import SettingsService from '../../services/api/Settings.service';
import useToastStore from '../../store/Toast.store';
import { ApplyPolicy } from '../../models/interfaces/Props.interfaces';
import { isString } from '../../utils/utils';
import SaveButton from '../settings/SaveButton';
import { CV_RULES, cvRuleLabel, GUEST_MODES, guestModeHint, guestModeLabel } from '../../utils/applyPolicy';

interface ApplyPolicySettingsProps {
    onSaved?: (value: ApplyPolicy) => void;
}

/**
 * Site-wide defaults for the ways to apply ("הגדרות הגשה"): what a visitor who is not signed in can do
 * (self / quick / closed), and whether a CV is required on a quick and on a regular application.
 * Each job can override each of them (jobs-management table / job form).
 */
/** A native radio (keyboard and screen readers work as usual). */
export const Radio: React.FC<{ name: string; value: string; label: string; checked: boolean; describedBy?: string; onChange: () => void }> = ({
    name, value, label, checked, describedBy, onChange,
}) => (
    <div className="form-check apply-settings__radio">
        <input className="form-check-input float-none mx-1" type="radio" id={`${name}-${value}`} name={name} value={value}
            checked={checked} onChange={onChange} aria-describedby={describedBy} />
        <label className="form-check-label font-RubikMedium" htmlFor={`${name}-${value}`}>{label}</label>
    </div>
);

// On the settings screen (/settings) only. The employer posting setting is in the job-posting section
// (EmployerPostingSettings, owner 23.11.2026).
const ApplyPolicySettings: React.FC<ApplyPolicySettingsProps> = ({ onSaved }) => {
    const t = i18n.getTranslations().ApplyPolicy;
    const { showToast } = useToastStore();
    const [values, setValues] = useState<ApplyPolicy | null>(null);
    const [failed, setFailed] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            const result = await SettingsService.getInstance().getApplyPolicy();
            if (isString(result)) {
                showToast(result, 'error');
                setFailed(true);
                return;
            }
            setValues(result);
        })();
    }, []);

    const save = async () => {
        if (!values) return;
        setSaving(true);
        const result = await SettingsService.getInstance().updateApplyPolicy(values);
        if (isString(result)) {
            setSaving(false);
            showToast(result, 'error');
            return;
        }
        setSaving(false);
        showToast(t.Saved, 'success');
        onSaved?.(result);
    };

    if (failed) return <p role="alert" className="sec-note">{t.LoadFailed}</p>;
    if (!values) return <div className="p-5"><CircularLoader /></div>;

    const cvGroup = (key: 'quickCv' | 'regularCv', label: string, hint: string) => (
        <fieldset className="apply-settings__group" aria-describedby={`apply-settings-${key}-hint`}>
            <legend className="font-RubikMedium fs-6 mb-1">{label}</legend>
            <div id={`apply-settings-${key}-hint`} className="font-RubikSmall text-color-dark-grey mb-1">{hint}</div>
            <div className="d-flex flex-wrap gap-3">
                {CV_RULES.map((r) => (
                    <Radio key={r} name={`apply-settings-${key}`} value={r} label={cvRuleLabel(r)}
                        checked={values[key] === r} onChange={() => setValues({ ...values, [key]: r })} />
                ))}
            </div>
        </fieldset>
    );

    return (
        <div className="apply-settings">
            <p className="font-RubikSmall pb-2">{t.SettingsInstructions}</p>
            <fieldset className="apply-settings__group" aria-describedby="apply-settings-guest-hint">
                <legend className="font-RubikMedium fs-6 mb-1">{t.GuestModeLabel}</legend>
                <div id="apply-settings-guest-hint" className="font-RubikSmall text-color-dark-grey mb-1">{t.GuestModeHint}</div>
                {GUEST_MODES.map((m) => (
                    <div key={m} className="apply-settings__option">
                        <Radio name="apply-settings-guest" value={m} label={guestModeLabel(m)} describedBy={`apply-settings-guest-${m}-hint`}
                            checked={values.guestMode === m} onChange={() => setValues({ ...values, guestMode: m })} />
                        <div id={`apply-settings-guest-${m}-hint`} className="font-RubikSmall text-color-dark-grey apply-settings__option-hint">{guestModeHint(m)}</div>
                    </div>
                ))}
            </fieldset>
            {cvGroup('quickCv', t.QuickCvLabel, t.QuickCvHint)}
            {cvGroup('regularCv', t.RegularCvLabel, t.RegularCvHint)}
            <div className="d-flex align-items-center gap-3 mt-3 flex-wrap">
                <SaveButton onClick={save} disabled={saving} testId="apply-settings-save" />
            </div>
        </div>
    );
};

export default ApplyPolicySettings;
