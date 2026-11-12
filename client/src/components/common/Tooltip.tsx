import React, { ReactNode } from 'react';

interface CustomTooltipProps {
  text: string;
  children: ReactNode;
  placement?: 'top' | 'bottom';
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({
  text,
  children,
  placement = 'top',
}) => {
  return (
    <div className={`tooltip-wrapper ${placement}`}>
      {children}
      <div className="tooltip-bubble">
        <span className="tooltip-text font-RubikSmall">{text}</span>
      </div>
    </div>
  );
};

export default CustomTooltip;