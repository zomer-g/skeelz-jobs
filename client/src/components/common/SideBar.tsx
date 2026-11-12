import React from 'react';

export interface SidebarButton {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  iconColor?: string;
  buttons: SidebarButton[];
  footerButton?: SidebarButton;
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  side = 'right',
  iconColor = '#CD0077',
  buttons,
  footerButton,
}) => {
  return (
    <div className={`sidebar ${side} ${isOpen ? 'open' : ''}`}>
      <button className="close-btn" onClick={onClose} >
        ×
      </button>

      <ul className="menu">
  {buttons.map((btn, i) => (
    <li
      key={i}
      onClick={btn.onClick}
      style={{ color: iconColor }}
      className="menu-item mt-3 d-flex align-items-center gap-2"
    >
      {btn.icon && (
        <span className="d-flex align-items-center ms-1" style={{ marginTop: '2px' }}>
        {btn.icon}
      </span>
      )}
      <span className="font-RubikMedium fs-16">{btn.label}</span>
    </li>
  ))}
</ul>

      {footerButton && (
        <button className="footer-btn" onClick={footerButton.onClick}>
          {footerButton.icon && <span className="icon">{footerButton.icon}</span>}
          <span className='font-RubikMedium fs-16'>{footerButton.label}</span>
        </button>
      )}
    </div>
  );
};

export default Sidebar;
