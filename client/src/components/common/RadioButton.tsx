import React from 'react';
import { CheckIcon } from '../../icons';
import { i18n } from '../../i18n/I18n';

interface RadioButtonProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    className?: string;
}

const RadioButton: React.FC<RadioButtonProps> = ({
    name,
    checked,
    onChange,
    disabled,
    label,
    className = '',
    ...rest
}) => {
    const isRTL = i18n.isRTL();

    return (
        <label
            className={`d-flex align-items-center p-2 ${className}`}
            style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
            <input
                type="radio"
                name={name}
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                className="d-none"
                {...rest}
            />
            <span
                className={`d-flex justify-content-center height-1rem width-1rem align-items-center rounded-1 border ${
                    checked ? 'border-color-blue-2 background-color-blue-1' : 'bg-transparent'
                }`}
            >
                {checked && <CheckIcon />}
            </span>
            {label && <span className={isRTL ? 'me-2' : 'ms-2'}>{label}</span>}
        </label>
    );
};

export default RadioButton;
