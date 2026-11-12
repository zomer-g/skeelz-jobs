import React from 'react';

interface SpinnerProps {
  size?: 'sm' | 'lg'; // Optional size for the spinner
  color?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info' | 'light' | 'dark'; // Optional color for the spinner
  srText?: string; // Screen reader text
}

const Spinner: React.FC<SpinnerProps> = ({ size='lg', color = 'primary', srText = 'Loading...' }) => {
  return (
    <div
      className={`spinner-border${size ? ` spinner-border-${size}` : ''} text-${color}`}
      role="status"
    >
      <span className="sr-only">{srText}</span>
    </div>
  );
};

export default Spinner;
