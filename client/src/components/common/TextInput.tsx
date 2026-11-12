import React, { useState, forwardRef } from 'react';
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';
import { Direction, InputType } from '../../i18n/General.enums';
import Button from './Button';
import { EyeClosedIcon, EyeOpenIcon } from '../../icons';

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    name: string;
    label?: string;
    labelClassName?: string;
    className?: string;
    inputClassName?: string;
    error?: string | null;
    touched?: boolean;
    direction?: Direction;
    customSize?: boolean;
}

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(({
    label,
    name,
    type = InputType.Text,
    placeholder,
    disabled = false,
    className = '',
    inputClassName = '',
    labelClassName = '',
    customSize = false,
    value,
    onChange,
    onBlur,
    error,
    direction = Direction.Ltr,
    required,
    ...rest // Spread other input props
}, ref) => {
    const [inputType, setInputType] = useState(type);

    const toggleShowPassword = () => {
        setInputType(inputType === InputType.Password ? InputType.Text : InputType.Password);
    };

    return (
        <div className={`max-width-20rem w-100 ${className}`}>
            {label && (
                <Label
                    htmlFor={name}
                    required={required}
                    className={`font-RubikRegular ${labelClassName}`}
                >
                    {label}
                </Label>
            )}
            <div className="position-relative">
                <input
                    id={name}
                    name={name}
                    type={inputType}
                    placeholder={placeholder}
                    disabled={disabled}
                    className={`form-control border-color-grey-2 ${!customSize ? 'h-3rem' : ''} ${inputClassName} ${disabled ? 'color-grey background-color-white' : ''}`}
                    value={value}
                    onChange={onChange}
                    onBlur={onBlur}
                    ref={ref}
                    {...rest} // Apply remaining input attributes
                />
                {type === InputType.Password && (
                    <Button
                        onClick={toggleShowPassword}
                        iconOnlyStyle
                        className={`position-absolute top-50 translate-middle-y ${direction === Direction.Ltr ? 'start-0 ms-3' : 'end-0 me-3'}`}
                    >
                        {inputType === InputType.Password ? <EyeOpenIcon /> :<EyeClosedIcon /> }
                    </Button>
                )}
            </div>
            {error && <FieldErrorMessageComponent error={error} />}
        </div>
    );
});

export default TextInput;
