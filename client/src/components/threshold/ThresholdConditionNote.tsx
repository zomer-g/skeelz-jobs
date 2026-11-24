// תנאי סף on the job page: shown as plain text (never HTML), before the candidate starts to apply. The confirmation
// itself is asked when they send the application (ThresholdConfirmDialog; the server enforces it).
import React from 'react';
import { i18n } from '../../i18n/I18n';

export const ThresholdConditionNote: React.FC<{ text?: string | null; id: string }> = ({ text, id }) => {
  if (!text || !text.trim()) return null;
  const t = i18n.getTranslations().Threshold;
  return (
    <section className="threshold-note mb-3 p-3" aria-labelledby={`threshold-note-${id}`}
      style={{ background: '#f5f2ff', borderInlineStart: '4px solid #5b3fd1', borderRadius: 6 }}>
      <h3 id={`threshold-note-${id}`} className="font-RubikBold fs-6 mb-1">
        <i className="bi bi-patch-check me-1 ms-1" aria-hidden="true" />{t.OnJobPage}
      </h3>
      <p dir="auto" className="font-RubikRegular mb-0" style={{ whiteSpace: 'pre-line' }}>{text}</p>
    </section>
  );
};

export default ThresholdConditionNote;
