import React from 'react';

interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
  required?: boolean;
  requiredClassName?: string;
}

const Label: React.FC<LabelProps> = ({
  htmlFor,
  className = '',
  children,
  required = false,
  requiredClassName = 'color-attention',
  ...rest // Spread additional label attributes
}) => (
  <label htmlFor={htmlFor} className={`form-label ${className}`} {...rest}>
    {required && <span className={requiredClassName}>*</span>} {children} 
  </label>
);

export default Label;
