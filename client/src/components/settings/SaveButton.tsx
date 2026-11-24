// The one save button of the settings screen (/settings, owner 23.11.2026: every save there looks the same):
// the staff screens' primary pill, a check icon, "שמירה"; disabled = the same pill, faded.
import React from 'react';

interface SaveButtonProps {
  disabled?: boolean;
  testId?: string;
  /** Without onClick it submits its form. */
  onClick?: () => void;
  label?: string;
}

const SaveButton: React.FC<SaveButtonProps> = ({ disabled, testId, onClick, label = 'שמירה' }) => (
  <button type={onClick ? 'button' : 'submit'} className="sec-btn sec-btn--primary" disabled={disabled} data-testid={testId} onClick={onClick}>
    <i className="bi bi-check2" aria-hidden="true" />{label}
  </button>
);

export default SaveButton;
