// The employer's sign-up form, after a verified identity (Google, Microsoft, or a code by email). Posts to the same
// sign-up endpoint as a candidate's with accountType: 'employer'; the server takes the email only from its own signed
// cookie (server/src/services/employerAccounts.ts). Also used as the "edit my details" form in the employer area.
import React, { useState } from 'react';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import ConsentChecks, { ConsentValues } from '../consent/ConsentChecks';

export type EmployerDetails = { firstName: string; lastName: string; companyName: string; phone: string; jobTitle: string };
type Bad = Partial<Record<keyof EmployerDetails, string>>;

const PHONE_OK = (v: string) => {
  const d = v.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(d)) return false;
  const stripped = d.replace(/^0+/, '');
  return (stripped.startsWith('5') && stripped.length === 9) || /^(02|03|04|08|09)\d{7}$/.test(d);
};

/** The same rules as the server (security/employer.ts checkEmployerProfile). */
export const checkDetails = (v: EmployerDetails): Bad => {
  const t = i18n.getTranslations().Employers;
  const bad: Bad = {};
  for (const k of ['firstName', 'lastName'] as const) {
    const s = v[k].trim();
    if (s.length < 2 || s.length > 30 || /\d/.test(s)) bad[k] = t.NameInvalid;
  }
  const c = v.companyName.trim();
  if (c.length < 2 || c.length > 80) bad.companyName = t.CompanyInvalid;
  if (!PHONE_OK(v.phone.trim())) bad.phone = t.PhoneInvalid;
  return bad;
};

export const DetailsFields: React.FC<{
  prefix: string; values: EmployerDetails; bad: Bad; disabled?: boolean; email?: string; emailHint?: string;
  onChange: (p: Partial<EmployerDetails>) => void;
}> = ({ prefix, values, bad, disabled, email, emailHint, onChange }) => {
  const t = i18n.getTranslations().Employers;
  const field = (k: keyof EmployerDetails, label: string, opts: { required?: boolean; type?: string; auto?: string; dir?: string; max?: number } = {}) => {
    const id = `${prefix}-${k}`;
    return (
      <div className="col-md-6 mb-3">
        <label htmlFor={id} className="form-label font-RubikRegular">
          {opts.required && <span className="color-attention" aria-hidden="true">*</span>} {label}
        </label>
        <input id={id} name={k} className="form-control border-color-grey-2" type={opts.type ?? 'text'} value={values[k]}
          autoComplete={opts.auto} dir={opts.dir} maxLength={opts.max} required={opts.required} disabled={disabled}
          aria-invalid={bad[k] ? true : undefined} aria-describedby={bad[k] ? `${id}-error` : undefined}
          onChange={(e) => onChange({ [k]: e.target.value } as Partial<EmployerDetails>)} />
        {bad[k] && <div id={`${id}-error`} className="text-danger small mt-1">{bad[k]}</div>}
      </div>
    );
  };
  return (
    <div className="row">
      {email !== undefined && (
        <div className="col-12 mb-3">
          <label htmlFor={`${prefix}-email`} className="form-label font-RubikRegular">{t.Email}</label>
          <input id={`${prefix}-email`} className="form-control bg-light" value={email} readOnly dir="ltr" aria-describedby={emailHint ? `${prefix}-email-hint` : undefined} />
          {emailHint && <div id={`${prefix}-email-hint`} className="small text-muted">{emailHint}</div>}
        </div>
      )}
      {field('firstName', t.FirstName, { required: true, auto: 'given-name', max: 30 })}
      {field('lastName', t.LastName, { required: true, auto: 'family-name', max: 30 })}
      {field('companyName', t.Company, { required: true, auto: 'organization', max: 80 })}
      {field('phone', t.Phone, { required: true, type: 'tel', auto: 'tel', dir: 'ltr', max: 20 })}
      {field('jobTitle', t.JobTitle, { auto: 'organization-title', max: 60 })}
    </div>
  );
};

const EmployerSignUp: React.FC<{
  email: string; emailHint: string; prefill?: Partial<EmployerDetails>;
  submit: (values: Record<string, unknown>) => Promise<string | null>; // null = done, else the error text
  onBack?: () => void;
}> = ({ email, emailHint, prefill, submit, onBack }) => {
  useLanguageStore();
  const t = i18n.getTranslations().Employers;
  const [values, setValues] = useState<EmployerDetails>({ firstName: '', lastName: '', companyName: '', phone: '', jobTitle: '', ...prefill });
  const [consent, setConsent] = useState<ConsentValues>({ consent: false, marketingConsent: false });
  const [bad, setBad] = useState<Bad>({});
  const [tried, setTried] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setTried(true);
    const b = checkDetails(values);
    setBad(b);
    const firstBad = (Object.keys(b) as (keyof EmployerDetails)[])[0];
    if (firstBad) { document.getElementById(`emp-signup-${firstBad}`)?.focus(); return; }
    if (!consent.consent) { setConsentError(true); document.getElementById('emp-signup-consent')?.focus(); return; }
    setBusy(true); setError('');
    const r = await submit({ accountType: 'employer', ...values, jobTitle: values.jobTitle.trim() || undefined, ...consent });
    setBusy(false);
    if (r) setError(r);
  };

  return (
    <form noValidate onSubmit={onSubmit} className="p-4" dir={i18n.isRTL() ? 'rtl' : 'ltr'}>
      <p className="font-RubikRegular" role="note">{t.SignUpIntro}</p>
      <DetailsFields prefix="emp-signup" values={values} bad={tried ? bad : {}} disabled={busy} email={email} emailHint={emailHint}
        onChange={(p) => { const n = { ...values, ...p }; setValues(n); if (tried) setBad(checkDetails(n)); }} />
      <ConsentChecks idPrefix="emp-signup" audience="employer" className="pb-3" values={consent} termsError={consentError} disabled={busy}
        onChange={(v) => { setConsent(v); if (v.consent) setConsentError(false); }} />
      <div aria-live="assertive" className="text-danger mb-2">{error}</div>
      <div className="d-flex gap-2 flex-wrap justify-content-between">
        {onBack && <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={onBack} disabled={busy}>{t.Back}</button>}
        <button type="submit" className="btn bg-color-purple text-white rounded-pill px-4" disabled={busy} aria-busy={busy}>{t.CreateAccount}</button>
      </div>
    </form>
  );
};

export default EmployerSignUp;
