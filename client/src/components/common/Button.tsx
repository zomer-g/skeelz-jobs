import React, { ReactNode, ButtonHTMLAttributes } from 'react';

interface CustomButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  onClick?: () => void;
  className?: string; // Allow custom class names
  customStyle?: boolean; // If true, className overrides default styles
  iconOnlyStyle?: boolean;
}

const Button: React.FC<CustomButtonProps> = ({ children, onClick, className = '', customStyle = false, iconOnlyStyle, type = 'button',
  ...props }) => {
  const baseClasses = `btn ${iconOnlyStyle ? '': 'font-RubikMedium rounded-pill border-0 btn-h text-white fw-500 d-flex align-items-center justify-content-center'} `;
  const iconOnlyClasses = iconOnlyStyle ? 'p-0 bg-transparent border-0' : '';
  const combinedClasses = customStyle ? `btn ${className}` : `${baseClasses} ${iconOnlyClasses} ${className}`.trim();

  return (
    <button
      className={combinedClasses}
      onClick={onClick}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
