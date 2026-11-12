import React from 'react';
import { i18n } from '../../i18n/I18n';
import RadioButton from '../common/RadioButton';
import { choiceToOverride, OverrideChoice, overrideToChoice } from '../../utils/applyPolicy';

interface ApplyPolicyOverrideFieldProps {
    name: string;
    label: string;
    hint?: string;
    /** The job's override: null/undefined = inherit. */
    value: boolean | null | undefined;
    /** The current site-wide default, shown next to "inherit" (unknown while loading). */
    inheritedValue?: boolean;
    disabled?: boolean;
    onChange: (value: boolean | null) => void;
}

/** Tri-state control for one per-job apply policy: inherit the default / on / off. */
const ApplyPolicyOverrideField: React.FC<ApplyPolicyOverrideFieldProps> = ({
    name, label, hint, value, inheritedValue, disabled, onChange,
}) => {
    const t = i18n.getTranslations().ApplyPolicy;
    const choice = overrideToChoice(value);
    const inheritLabel = inheritedValue === undefined
        ? t.Inherit
        : t.InheritCurrently.replace('{value}', inheritedValue ? t.Enabled : t.Disabled);
    const options: { value: OverrideChoice; label: string }[] = [
        { value: 'inherit', label: inheritLabel },
        { value: 'on', label: t.Enabled },
        { value: 'off', label: t.Disabled },
    ];

    return (
        <fieldset className="mb-3" disabled={disabled} aria-describedby={hint ? `${name}-hint` : undefined}>
            <legend className="font-RubikMedium fs-6 mb-1">{label}</legend>
            {hint && <div id={`${name}-hint`} className="font-RubikSmall text-color-dark-grey mb-1">{hint}</div>}
            <div className="d-flex flex-wrap gap-3">
                {options.map((o) => (
                    <RadioButton
                        key={o.value}
                        name={name}
                        value={o.value}
                        label={o.label}
                        checked={choice === o.value}
                        disabled={disabled}
                        className="font-RubikSmall p-1"
                        onChange={() => onChange(choiceToOverride(o.value))}
                    />
                ))}
            </div>
        </fieldset>
    );
};

export default ApplyPolicyOverrideField;
