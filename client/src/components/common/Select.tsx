import React, { useState, useRef } from 'react';
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';
import Checkbox from './Checkbox';
import { ArrowDownIcon } from '../../icons';
import { i18n } from '../../i18n/I18n';

interface Option {
    value: string;
    label: string;
    disabled?: boolean;
}

interface SelectProps {
    label: string;
    name: string;
    options: Option[];
    value: string | string[]; // Supports single or multiple values.
    onChange: (e: React.ChangeEvent<{ name: string; value: any }>) => void; // Match Formik's onChange.
    onBlur?: (e: React.FocusEvent<HTMLDivElement | HTMLSelectElement>) => void;
    error?: string;
    required?: boolean;
    multiple?: boolean;
    className?: string;
}

const Select: React.FC<SelectProps> = ({
    label,
    name,
    options,
    value,
    onChange,
    onBlur,
    error,
    required = false,
    multiple = false,
    className = '',
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const isRTL = i18n.isRTL();
    const translations = i18n.getTranslations();

    const toggleDropdown = () => setIsOpen((prev) => !prev);

    const handleOptionChange = (selectedValue: string, checked: boolean) => {
        const currentValue = Array.isArray(value) ? value : [];
        const updatedValues = checked
            ? [...currentValue, selectedValue]
            : currentValue.filter((v) => v !== selectedValue);

        const syntheticEvent = {
            target: {
                name,
                value: updatedValues,
            },
        };

        onChange(syntheticEvent as React.ChangeEvent<{ name: string; value: any }>);
    };

    const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
        const relatedTarget = event.relatedTarget as HTMLElement;

        if (dropdownRef.current && dropdownRef.current.contains(relatedTarget)) {
            return;
        }

        const syntheticBlurEvent = {
            target: {
                name,
                value,
            },
        };

        if (onBlur) {
            onBlur(syntheticBlurEvent as React.FocusEvent<HTMLDivElement | HTMLSelectElement>);
        }

        setIsOpen(false);
    };

    const handleClickOutside = (event: MouseEvent) => {
        if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
            setIsOpen(false);
        }
    };

    React.useEffect(() => {
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        } else {
            document.removeEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const renderDisplayValue = () => {
        const currentValue = Array.isArray(value) ? value : [];
        if (multiple) {
            return currentValue
                .map((v) => options.find((opt) => opt.value === v)?.label || '')
                .join(', ');
        }
        const selectedOption = options.find((opt) => opt.value === value);
        return selectedOption ? selectedOption.label : `${label}`;
    };

    const renderSelectBox = () => (
        <div
            className={`form-select position-relative background-none d-flex align-items-center border-color-grey-2 cursor-pointer w-100 h-3rem ${isRTL ? 'form-select-rtl' : ''}`}
            onClick={toggleDropdown}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && toggleDropdown()}
        >
            <span className={`flex-grow-1 ps-1 text-truncate ${isRTL ? 'text-end' : 'text-start'}`}> {renderDisplayValue()}</span>
            <div className="d-flex align-items-center h-3rem">
                <div
                    className={`${isRTL ? 'border-end left-3rem' : 'border-start right-3rem'} border-color-grey-2 position-absolute top-0 h-100 pointer-events-none`}
                ></div>
                <span className={`position-absolute ${isRTL ? 'left-1-19rem' : 'right-1-19rem'}`}>
                    <ArrowDownIcon size={12} color="var(--grey-2)" />
                </span>
            </div>
        </div>
    );

    if (!multiple) {
        return (
            <div className={`max-width-20rem w-100 mb-3 ${className}`}>
                <Label htmlFor={name} required={required} className='font-RubikRegular'>
                    {label}
                </Label>
                <div className="position-relative">
                    {renderSelectBox()}
                    <select
                        id={name}
                        name={name}
                        value={value}
                        onChange={onChange}
                        onBlur={onBlur}
                        className={`opacity-0 position-absolute top-0 start-0 w-100 h-100 ${isRTL ? 'form-select-rtl' : ''}`}
                    >
                        <option value="" disabled>
                            {translations.Inputs.Select} {label}
                        </option>
                        {options.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </div>
                {error && <FieldErrorMessageComponent error={error} />}
            </div>
        );
    }

    return (
        <div
            className={`max-width-20rem w-100 mb-3 position-relative ${className}`}
            ref={dropdownRef}
            onBlur={handleBlur}
        >
            <Label htmlFor={name} required={required}>
                {label}
            </Label>
            {renderSelectBox()}
            {isOpen && (
                <div
                    className="position-absolute bg-white shadow border rounded w-100 z-index-10"
                    style={{ maxHeight: '200px', overflowY: 'auto' }}
                    onMouseDown={(e) => e.preventDefault()}
                >
                    {options.map((option) => (
                        <Checkbox
                            key={option.value}
                            name={name}
                            label={option.label}
                            checked={Array.isArray(value) && value.includes(option.value)}
                            onChange={(e) => handleOptionChange(option.value, e.target.checked)}
                            disabled={option.disabled}
                            className="p-2"
                        />
                    ))}
                </div>
            )}
            {error && <FieldErrorMessageComponent error={error} />}
        </div>
    );
};

export default Select;
