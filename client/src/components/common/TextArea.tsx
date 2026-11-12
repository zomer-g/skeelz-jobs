import React from 'react';
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    label: string;
    error?: string;
    required?: boolean;
}

const Textarea: React.FC<TextareaProps> = ({
    label,
    name = '', // Ensure a default name for accessibility
    required = false,
    error,
    className = '',
    ...textareaProps
}) => {
    return (
        <div className={`mb-3 ${className}`}>
            <Label htmlFor={name} required={required}>
                {label}
            </Label>
            <textarea
                id={name} // Match name for accessibility
                name={name}
                required={required}
                className={`form-control border-color-grey-2 ${className || ''}`}
                {...textareaProps} // Spread other props like `onChange`, `onBlur`, `placeholder`, etc.
            />
            {error && <FieldErrorMessageComponent error={error}/>}
        </div>
    );
};

export default Textarea;
