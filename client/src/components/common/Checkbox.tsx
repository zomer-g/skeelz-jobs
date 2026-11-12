import React from 'react';
import { CheckIcon } from '../../icons';
import { i18n } from '../../i18n/I18n';

interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    className?: string;
    boxSize?:string;
}

const Checkbox: React.FC<CheckboxProps> = ({
    name,
    checked,
    onChange,
    disabled,
    label,
    boxSize = '1rem',
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
                type="checkbox"
                name={name}
                checked={checked}
                value="true"
                onChange={onChange}
                disabled={disabled}
                className="d-none"
                {...rest}
            />
            <span
                className={`d-flex justify-content-center align-items-center rounded-1 border ${
                    checked ? 'border-color-blue-2 background-color-blue-1' : 'bg-transparent'
                }`}
                style={{
                    width: boxSize,
                    height: boxSize,
                  }}
            >
                {checked && <CheckIcon/>}
            </span>
            {label && <span className={isRTL? "me-2" : "ms-2"}>{label}</span>}
        </label>
    );
};

export default Checkbox;
