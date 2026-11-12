import React, { useEffect, useState } from 'react';
import { FormControlLabel } from '@mui/material';
import { i18n } from '../../i18n/I18n';
import IOSSwitch from '../common/IosSwitch';
import Button from '../common/Button';
import CircularLoader from '../common/CircularLoader';
import SettingsService from '../../services/api/Settings.service';
import useToastStore from '../../store/Toast.store';
import { ApplyPolicy } from '../../models/interfaces/Props.interfaces';
import { isString } from '../../utils/utils';

interface ApplyPolicySettingsProps {
    onClose: () => void;
    onSaved?: (value: ApplyPolicy) => void;
}

/** Admin screen for the site-wide apply policy defaults. */
const ApplyPolicySettings: React.FC<ApplyPolicySettingsProps> = ({ onClose, onSaved }) => {
    const t = i18n.getTranslations().ApplyPolicy;
    const { showToast } = useToastStore();
    const [values, setValues] = useState<ApplyPolicy | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            const result = await SettingsService.getInstance().getApplyPolicy();
            if (isString(result)) {
                showToast(result, 'error');
                onClose();
                return;
            }
            setValues(result);
        })();
    }, []);

    const save = async () => {
        if (!values) return;
        setSaving(true);
        const result = await SettingsService.getInstance().updateApplyPolicy(values);
        setSaving(false);
        if (isString(result)) {
            showToast(result, 'error');
            return;
        }
        showToast(t.Saved, 'success');
        onSaved?.(result);
        onClose();
    };

    if (!values) return <div className="p-5"><CircularLoader /></div>;

    const row = (key: keyof ApplyPolicy, label: string, hint: string, disabled = false) => (
        <div className="d-flex align-items-start py-2">
            <FormControlLabel
                label=""
                className="m-0 pe-2 ps-2"
                control={
                    <IOSSwitch
                        sx={{ m: 1 }}
                        checked={values[key]}
                        disabled={disabled}
                        inputProps={{ 'aria-label': label }}
                        onChange={(_e, checked) => setValues({ ...values, [key]: checked })}
                    />
                }
            />
            <div>
                <div className="font-RubikMedium">{label}</div>
                <div className="font-RubikSmall text-color-dark-grey">{hint}</div>
            </div>
        </div>
    );

    return (
        <div className="p-4">
            <p className="font-RubikSmall pb-2">{t.SettingsInstructions}</p>
            {row('quickApply', t.QuickApply, t.QuickApplyHint)}
            {row('quickApplyWithoutCv', t.QuickApplyWithoutCv,
                values.quickApply ? t.QuickApplyWithoutCvHint : `${t.QuickApplyWithoutCvHint} · ${t.OnlyWhenQuickApply}`,
                !values.quickApply)}
            <div className="d-flex justify-content-end gap-3 pt-4">
                <Button className="font-RubikMedium bg-white text-color-dark-green-2 border-color-dark-green-2 rounded-pill px-4" onClick={onClose}>
                    {t.Cancel}
                </Button>
                <Button className="bg-color-purple-btn rounded-pill px-4" onClick={save} disabled={saving}>
                    {t.Save}
                </Button>
            </div>
        </div>
    );
};

export default ApplyPolicySettings;
