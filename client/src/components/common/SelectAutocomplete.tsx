import React, { useState, useRef, useEffect } from 'react';
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';
import Checkbox from './Checkbox';
import { ArrowDownIcon } from '../../icons';
import { i18n } from '../../i18n/I18n';

type OptionsMap = Record<number| string, string>

interface SelectProps {
    label: string;
    name: string;
    options: OptionsMap;
    value: number | string ; // Supports single or multiple values.
    onChange: (e: React.ChangeEvent<{ name: string; value: string | string[] }>) => void; // Match Formik's onChange.
    onBlur?: (e: React.FocusEvent<HTMLDivElement | HTMLSelectElement>) => void;
    error?: string;
    required?: boolean;
    multiple?: boolean;
    className?: string;
    onValueChange?: (newValue: string) => void;
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
    onValueChange,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const isRTL = i18n.isRTL();

    useEffect(() => {
        if (value) {
            if (typeof value === "string" || typeof value === "number") {
                const selectedLabel = options[value] || ""; // Get label safely
                setSearchTerm(selectedLabel);
    
                if (onValueChange) {
                    onValueChange(selectedLabel);
                }
            }
        } else {
            setSearchTerm(""); // Reset if no value is selected
        }
    }, [value, options, multiple]);
    
    const toggleDropdown = () => setIsOpen((prev) => !prev);

    const handleOptionChange = (selectedValue: string | number) => {
        const event = Object.create(null);
        event.target = { name, value: selectedValue };
    
        onChange(event);
    
        const matchingLabel = options[selectedValue] || '';
        setSearchTerm(matchingLabel);
        setIsOpen(false);
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

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setSearchTerm(e.target.value);
    };

    const normalizeString = (str: string) => {
        if (typeof str !== "string") {
            return "";
        }
        return str
            .toLowerCase()
            .replace(/[\s-]+/g, ""); // Normalize spaces and hyphens by removing them
    };
    
    
    const filteredOptions = Object.entries(options).filter(([key, value]) =>
        normalizeString(value).includes(normalizeString(searchTerm))
    );
    

    const renderSelectBox = () => (
        <div
            className={`form-select position-relative background-none d-flex align-items-center border-color-grey-2  h-3rem ${
                isRTL ? 'form-select-rtl' : ''
            }`}
            ref={dropdownRef}
            onClick={() => setIsOpen(true)}
            onBlur={handleBlur}
        >
            <input
                type="text"
                className={`form-control flex-grow-1 px-2 text-truncate border-0 ${isRTL ? 'text-end' : 'text-start'
                    }`}
                placeholder={label}
                value={searchTerm}
                onChange={handleSearchChange}
                onFocus={() => setIsOpen(true)}
            />

            <span className={`position-absolute ${isRTL ? 'left-1-19rem' : 'right-1-19rem'}`}>
                <ArrowDownIcon size={12} color="var(--grey-2)" />
            </span>
        </div>
    );

    return (
        <div className={`max-width-20rem position-relative w-100 mb-3 ${className}`}>
            <Label htmlFor={name} required={required}>
                {label}
            </Label>
            {renderSelectBox()}
            {isOpen && (
       <div
       className="position-absolute bg-white shadow border rounded w-100 z-index-10 autocomplete-dropdown-size"
       onMouseDown={(e) => e.preventDefault()}
   >
       {filteredOptions.map(([key, value]) => {
           return (
               <div key={key}>
                   {multiple ? (
                       <Checkbox
                           name={name}
                           label={value} // Display the value (label)
                           checked={Array.isArray(value) && value.includes(key)}
                           onChange={(e) => handleOptionChange(key)}
                           className="p-2"
                       />
                   ) : (
                       <div
                           className={`p-2 ${value === key ? 'bg-primary text-white' : 'text-dark'}`}
                           role="button"
                           tabIndex={0}
                           onClick={() => handleOptionChange(key)}
                       >
                           {value} {/* Display the value */}
                       </div>
                   )}
               </div>
           );
       })}
   </div>
   
            )}
            {error && <FieldErrorMessageComponent error={error} />}
        </div>
    );
    
};

export default Select;
