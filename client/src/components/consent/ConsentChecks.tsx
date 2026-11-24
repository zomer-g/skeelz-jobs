// The two consent boxes on every form that collects personal data (server/src/security/consent.ts):
// - required: terms of use + privacy policy (sent as `consent: true`);
// - optional, unticked: marketing mail and updates about cooperations (sent as `marketingConsent`).
// The server enforces the required box; this only shows it. Texts: i18n `Terms`.
import React from 'react';
import { i18n } from '../../i18n/I18n';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';

export interface ConsentValues { consent: boolean; marketingConsent: boolean }

interface Props {
  idPrefix: string;
  audience: 'candidate' | 'employer';
  values: ConsentValues;
  onChange: (v: ConsentValues) => void;
  showTerms?: boolean;
  showMarketing?: boolean;
  /** Show the "required" error under the terms box. */
  termsError?: boolean;
  disabled?: boolean;
  className?: string;
}

const ConsentChecks: React.FC<Props> = ({
  idPrefix, audience, values, onChange, showTerms = true, showMarketing = true, termsError, disabled, className = '',
}) => {
  const t = i18n.getTranslations().Terms;
  const termsId = `${idPrefix}-consent`;
  const marketingId = `${idPrefix}-marketing`;
  return (
    <div className={`d-flex flex-column gap-2 fs-14 font-RubikRegular ${className}`}>
      {showTerms && (
        <div className="d-flex align-items-start gap-2">
          <input className="form-check-input m-0 mt-1 flex-shrink-0" type="checkbox" id={termsId} name="consent"
            checked={values.consent} required disabled={disabled}
            aria-invalid={termsError ? true : undefined} aria-describedby={termsError ? `${termsId}-error` : undefined}
            onChange={(e) => onChange({ ...values, consent: e.target.checked })} />
          <div>
            <label className="form-check-label" htmlFor={termsId}>
              <span className="color-attention" aria-hidden="true">*</span>{' '}
              {t.TermsBefore}
              <a href={`${ClientRoutes.Privacy}#terms`} target="_blank" rel="noopener noreferrer">
                {t.TermsLink}<span className="visually-hidden"> {t.NewTab}</span>
              </a>
              {audience === 'employer' ? t.TermsAfterEmployer : t.TermsAfterCandidate}
            </label>
            {termsError && <div id={`${termsId}-error`} className="text-danger small" role="alert">{t.TermsRequired}</div>}
          </div>
        </div>
      )}
      {showMarketing && (
        <div className="d-flex align-items-start gap-2">
          <input className="form-check-input m-0 mt-1 flex-shrink-0" type="checkbox" id={marketingId} name="marketingConsent"
            checked={values.marketingConsent} disabled={disabled}
            onChange={(e) => onChange({ ...values, marketingConsent: e.target.checked })} />
          <label className="form-check-label" htmlFor={marketingId}>{t.Marketing}</label>
        </div>
      )}
    </div>
  );
};

export default ConsentChecks;
