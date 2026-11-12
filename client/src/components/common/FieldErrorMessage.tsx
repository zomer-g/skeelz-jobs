import React from 'react';

interface FieldErrorMessageProps {
  error?: string | null;
  className?: string;
}

const FieldErrorMessage: React.FC<FieldErrorMessageProps> = ({ error, className = 'text-danger' }) => {
  if (!error) return null; // Render nothing if there's no error

  return <div className={className}>{error}</div>;
};

export default FieldErrorMessage;
