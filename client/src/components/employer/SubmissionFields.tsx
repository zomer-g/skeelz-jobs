// The job + contact fields of an employer submission. Used by the public form
// (/post-job) and by staff when editing a pending submission, so both validate the
// same way. Native, labelled controls only (keyboard and screen-reader friendly):
// each error is tied to its field (aria-describedby / aria-invalid), and the
// form shows an error summary that is announced (role="alert").
// The server repeats every check (server/src/services/jobSubmissionRules.ts).
import React, { useEffect, useMemo, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import { getLocalizedOptions } from '../../i18n/i18nHelper';
import { LocalizedDataKey } from '../../i18n/General.enums';
import useLanguageStore from '../../store/Language.store';
import { LocationService } from '../../services/api/Location.service';
import { SkillsService } from '../../services/api/Skills.service';
import { isString } from '../../utils/utils';
import CustomFieldInputs from '../common/CustomFieldInputs';
import { customErrors, editRequestJobFields, FormField, getPublicJobFields, loadPublicJobFields } from '../../utils/customFields';

export interface SubmissionValues {
  title: string;
  companyName: string;
  citySymbol: string;
  jobScope: string[];
  requiredSkills: string[];
  description: string;
  externalLink: string;
  publicEmail: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** תנאי סף (optional, plain text): the candidate confirms it before applying. */
  thresholdCondition: string;
  /** Answers to the job form's added fields (settings screen), by field id. */
  customFields?: Record<string, string | boolean>;
}
export type FieldName = Exclude<keyof SubmissionValues, 'customFields'> | 'consent';
export type ErrorCode = 'required' | 'too_short' | 'too_long' | 'invalid';
/** An added field's error is keyed `customFields.<id>` (as the server answers). */
export type Errors = Partial<Record<FieldName | `customFields.${string}`, ErrorCode>>;

export const EMPTY_VALUES: SubmissionValues = {
  title: '', companyName: '', citySymbol: '', jobScope: [], requiredSkills: [], description: '',
  externalLink: '', publicEmail: '', contactName: '', contactEmail: '', contactPhone: '', thresholdCondition: '',
};

// Same caps as the server (SUBMISSION_FIELD_LIMITS).
export const LIMITS = {
  title: [2, 30], companyName: [2, 28], description: [30, 5000], contactName: [2, 70], externalLink: [0, 500],
  email: [0, 254], phoneDigits: [9, 15], skills: [1, 15], thresholdCondition: [3, 500],
} as const;

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Client-side check (the server decides). `consent` is checked only on the public form; `contact: false` skips the
 *  contact fields (an employer's edit request has none). */
export const validate = (v: SubmissionValues, opts: { consent?: boolean; contact?: boolean; onlyJobPageExtra?: boolean } = {}): Errors => {
  const e: Errors = {};
  const len = (k: 'title' | 'companyName' | 'contactName' | 'description', [min, max]: readonly [number, number]) => {
    const s = v[k].trim();
    if (!s) e[k] = 'required';
    else if (s.length < min) e[k] = 'too_short';
    else if (s.length > max) e[k] = 'too_long';
  };
  len('title', LIMITS.title);
  len('companyName', LIMITS.companyName);
  if (!v.citySymbol) e.citySymbol = 'required';
  if (!v.jobScope.length) e.jobScope = 'required';
  if (v.requiredSkills.length < LIMITS.skills[0]) e.requiredSkills = 'required';
  else if (v.requiredSkills.length > LIMITS.skills[1]) e.requiredSkills = 'too_long';
  len('description', LIMITS.description);
  const link = v.externalLink.trim();
  if (link) {
    try {
      const u = new URL(link);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) e.externalLink = 'invalid';
    } catch { e.externalLink = 'invalid'; }
    if (link.length > LIMITS.externalLink[1]) e.externalLink = 'too_long';
  }
  if (v.publicEmail.trim() && !EMAIL_RE.test(v.publicEmail.trim())) e.publicEmail = 'invalid';
  const threshold = (v.thresholdCondition ?? '').trim();
  if (threshold && threshold.length < LIMITS.thresholdCondition[0]) e.thresholdCondition = 'too_short';
  else if (threshold.length > LIMITS.thresholdCondition[1]) e.thresholdCondition = 'too_long';
  // The added job fields (same rule as the server's checkCustomValues).
  for (const [id, code] of Object.entries(customErrors(opts.onlyJobPageExtra ? editRequestJobFields() : getPublicJobFields(), v.customFields))) e[`customFields.${id}`] = code;
  if (opts.contact === false) { return e; }
  len('contactName', LIMITS.contactName);
  if (!e.contactName && /\d/.test(v.contactName)) e.contactName = 'invalid';
  if (!v.contactEmail.trim()) e.contactEmail = 'required';
  else if (!EMAIL_RE.test(v.contactEmail.trim())) e.contactEmail = 'invalid';
  const phone = v.contactPhone.trim();
  const digits = phone.replace(/\D/g, '').length;
  if (!phone) e.contactPhone = 'required';
  else if (!/^\+?[\d\s-]+$/.test(phone)) e.contactPhone = 'invalid';
  else if (digits < LIMITS.phoneDigits[0]) e.contactPhone = 'too_short';
  else if (digits > LIMITS.phoneDigits[1]) e.contactPhone = 'too_long';
  if (opts.consent === false) e.consent = 'required';
  return e;
};

/** Order of the fields on the page (focus goes to the first invalid one). */
export const FIELD_ORDER: FieldName[] = ['title', 'companyName', 'citySymbol', 'jobScope', 'requiredSkills', 'description',
  'externalLink', 'publicEmail', 'thresholdCondition', 'contactName', 'contactEmail', 'contactPhone', 'consent'];

export const fieldId = (prefix: string, k: FieldName) => `${prefix}-${k}`;

export const useFieldLabels = (): Record<FieldName, string> => {
  const t = i18n.getTranslations().EmployerForm;
  return {
    title: t.JobTitle, companyName: t.CompanyName, citySymbol: t.City, jobScope: t.JobScope, requiredSkills: t.Skills,
    description: t.Description, externalLink: t.ExternalLink, publicEmail: t.PublicEmail, contactName: t.ContactName,
    contactEmail: t.ContactEmail, contactPhone: t.ContactPhone, consent: t.ConsentLink,
    thresholdCondition: i18n.getTranslations().Threshold.Label,
  };
};

export const errorText = (code?: ErrorCode): string => {
  const t = i18n.getTranslations().EmployerForm;
  return code === 'required' ? t.Required : code === 'too_short' ? t.TooShort : code === 'too_long' ? t.TooLong : code ? t.Invalid : '';
};

/** "Please fix": announced, each item jumps to its field. */
export const ErrorSummary: React.FC<{ errors: Errors; prefix: string; summaryRef?: React.Ref<HTMLDivElement> }> = ({ errors, prefix, summaryRef }) => {
  const t = i18n.getTranslations().EmployerForm;
  const labels = useFieldLabels();
  const custom = getPublicJobFields().filter((f) => errors[`customFields.${f.id}`]);
  const keys = FIELD_ORDER.filter((k) => errors[k]);
  if (!keys.length && !custom.length) return null;
  return (
    <div ref={summaryRef} tabIndex={-1} role="alert" className="alert alert-danger">
      <p className="mb-1 font-RubikMedium">{t.ErrorSummary}</p>
      <ul className="mb-0">
        {keys.map((k) => (
          <li key={k}><a href={`#${fieldId(prefix, k)}`}>{labels[k]}: {errorText(errors[k])}</a></li>
        ))}
        {custom.map((f) => (
          <li key={f.id}><a href={`#${prefix}-cf-${f.id}`}>{f.label}: {errorText(errors[`customFields.${f.id}`])}</a></li>
        ))}
      </ul>
    </div>
  );
};

const Req = () => <span className="color-attention" aria-hidden="true">*</span>;

interface FieldsProps {
  prefix: string; // id prefix, unique per form on the page
  values: SubmissionValues;
  errors: Errors;
  onChange: (patch: Partial<SubmissionValues>) => void;
  disabled?: boolean;
  /** false: no contact section (an employer's edit request). */
  showContact?: boolean;
  /** An employer's edit request: every added field; the staff-only ones write-only (editRequestJobFields). */
  onlyJobPageExtra?: boolean;
}

const SubmissionFields: React.FC<FieldsProps> = ({ prefix, values, errors, onChange, disabled, showContact = true, onlyJobPageExtra = false }) => {
  const t = i18n.getTranslations().EmployerForm;
  const tt = i18n.getTranslations().Threshold;
  const { currentLanguage } = useLanguageStore();
  const [cities, setCities] = useState<{ citySymbol: number; city: string }[]>([]);
  const [skills, setSkills] = useState<{ _id: string; name: string }[]>([]);
  const [skillFilter, setSkillFilter] = useState('');
  const fieldsFor = (editRequest: boolean) => (editRequest ? editRequestJobFields() : getPublicJobFields());
  const [jobFields, setJobFields] = useState<FormField[]>(fieldsFor(onlyJobPageExtra));
  useEffect(() => { loadPublicJobFields().then(() => setJobFields(fieldsFor(onlyJobPageExtra))); }, [onlyJobPageExtra]);
  const scopes = useMemo(() => getLocalizedOptions(LocalizedDataKey.JOB_SCOPE, currentLanguage), [currentLanguage]);

  useEffect(() => {
    LocationService.getInstance().fetchAllLocations().then((r) => {
      if (!isString(r)) setCities([...r].sort((a, b) => a.city.localeCompare(b.city, 'he')));
    });
    SkillsService.getInstance().fetchSkillsListRequest().then((r) => {
      if (!isString(r)) setSkills([...r.skills].sort((a, b) => a.name.localeCompare(b.name, 'he')));
    });
  }, []);

  const id = (k: FieldName) => fieldId(prefix, k);
  const errId = (k: FieldName) => `${id(k)}-error`;
  const aria = (k: FieldName, hint?: string) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': [errors[k] ? errId(k) : '', hint ?? ''].filter(Boolean).join(' ') || undefined,
  });
  const Err = ({ k }: { k: FieldName }) =>
    errors[k] ? <div id={errId(k)} className="text-danger small mt-1">{errorText(errors[k])}</div> : null;

  const text = (k: Exclude<keyof SubmissionValues, 'customFields'>, label: string, opts: { required?: boolean; type?: string; max?: number; autoComplete?: string; dir?: string } = {}) => (
    <div className="mb-3">
      <label htmlFor={id(k)} className="form-label font-RubikRegular">{opts.required && <Req />} {label}</label>
      <input
        id={id(k)} name={k} type={opts.type ?? 'text'} className="form-control border-color-grey-2"
        value={values[k] as string} maxLength={opts.max} autoComplete={opts.autoComplete} dir={opts.dir}
        required={opts.required} disabled={disabled}
        onChange={(e) => onChange({ [k]: e.target.value } as Partial<SubmissionValues>)}
        {...aria(k)}
      />
      <Err k={k} />
    </div>
  );

  const toggle = (k: 'jobScope' | 'requiredSkills', v: string, on: boolean) =>
    onChange({ [k]: on ? [...values[k], v] : values[k].filter((x) => x !== v) } as Partial<SubmissionValues>);

  const shownSkills = skills.filter((s) => !skillFilter.trim() || s.name.toLowerCase().includes(skillFilter.trim().toLowerCase())
    || values.requiredSkills.includes(s._id));

  return (
    <>
      <fieldset className="mb-4">
        <legend className="fs-5 font-RubikBold">{t.JobSection}</legend>
        <div className="row">
          <div className="col-md-6">{text('title', t.JobTitle, { required: true, max: LIMITS.title[1] })}</div>
          <div className="col-md-6">{text('companyName', t.CompanyName, { required: true, max: LIMITS.companyName[1], autoComplete: 'organization' })}</div>
        </div>
        <div className="row">
          <div className="col-md-6 mb-3">
            <label htmlFor={id('citySymbol')} className="form-label font-RubikRegular"><Req /> {t.City}</label>
            <select id={id('citySymbol')} name="citySymbol" className="form-select border-color-grey-2" value={values.citySymbol}
              required disabled={disabled} onChange={(e) => onChange({ citySymbol: e.target.value })} {...aria('citySymbol')}>
              <option value="">{t.ChooseCity}</option>
              {cities.map((c) => <option key={c.citySymbol} value={String(c.citySymbol)}>{c.city}</option>)}
            </select>
            <Err k="citySymbol" />
          </div>
          <div className="col-md-6 mb-3">
            <fieldset id={id('jobScope')} tabIndex={-1} {...aria('jobScope')}>
              <legend className="form-label fs-6 font-RubikRegular"><Req /> {t.JobScope}</legend>
              {scopes.map((o) => (
                <div className="d-inline-flex align-items-center gap-2 me-3 ms-3" key={o.value}>
                  <input className="form-check-input m-0" type="checkbox" id={`${id('jobScope')}-${o.value}`} disabled={disabled}
                    checked={values.jobScope.includes(String(o.value))}
                    onChange={(e) => toggle('jobScope', String(o.value), e.target.checked)} />
                  <label className="form-check-label" htmlFor={`${id('jobScope')}-${o.value}`}>{o.label}</label>
                </div>
              ))}
              <Err k="jobScope" />
            </fieldset>
          </div>
        </div>

        <fieldset id={id('requiredSkills')} tabIndex={-1} className="mb-3" {...aria('requiredSkills', `${id('requiredSkills')}-count`)}>
          <legend className="form-label fs-6 font-RubikRegular"><Req /> {t.Skills}</legend>
          <div className="d-flex gap-3 align-items-center mb-2 flex-wrap">
            <label htmlFor={`${id('requiredSkills')}-filter`} className="visually-hidden">{t.SkillsFilter}</label>
            <input id={`${id('requiredSkills')}-filter`} type="search" className="form-control" style={{ maxWidth: 260 }}
              placeholder={t.SkillsFilter} value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} disabled={disabled} />
            <span id={`${id('requiredSkills')}-count`} className="small" aria-live="polite">
              {values.requiredSkills.length} {t.SkillsSelected} (1–{LIMITS.skills[1]})
            </span>
          </div>
          <div className="border rounded p-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shownSkills.map((s) => (
              <div className="d-flex align-items-center gap-2 py-1" key={s._id}>
                <input className="form-check-input m-0" type="checkbox" id={`${id('requiredSkills')}-${s._id}`} disabled={disabled}
                  checked={values.requiredSkills.includes(s._id)}
                  onChange={(e) => toggle('requiredSkills', s._id, e.target.checked)} />
                <label className="form-check-label" htmlFor={`${id('requiredSkills')}-${s._id}`}>{s.name}</label>
              </div>
            ))}
          </div>
          <Err k="requiredSkills" />
        </fieldset>

        <div className="mb-3">
          <label htmlFor={id('description')} className="form-label font-RubikRegular"><Req /> {t.Description}</label>
          <textarea id={id('description')} name="description" className="form-control border-color-grey-2" rows={8}
            maxLength={LIMITS.description[1]} required disabled={disabled} value={values.description}
            onChange={(e) => onChange({ description: e.target.value })} {...aria('description', `${id('description')}-hint`)} />
          <div id={`${id('description')}-hint`} className="small text-muted">
            {t.DescriptionHint} {values.description.trim().length}/{LIMITS.description[1]} {t.Characters}
          </div>
          <Err k="description" />
        </div>
      </fieldset>

      <fieldset className="mb-4">
        <legend className="fs-5 font-RubikBold">{t.ApplySection}</legend>
        <p className="small">{t.ApplyHint}</p>
        <div className="row">
          <div className="col-md-6">{text('externalLink', t.ExternalLink, { type: 'url', max: LIMITS.externalLink[1], dir: 'ltr' })}</div>
          <div className="col-md-6">{text('publicEmail', t.PublicEmail, { type: 'email', max: LIMITS.email[1], dir: 'ltr' })}</div>
        </div>
        <div className="mb-1">
          <label htmlFor={id('thresholdCondition')} className="form-label font-RubikRegular">{tt.Label}</label>
          <textarea id={id('thresholdCondition')} name="thresholdCondition" className="form-control border-color-grey-2" rows={2}
            maxLength={LIMITS.thresholdCondition[1]} disabled={disabled} value={values.thresholdCondition ?? ''}
            placeholder={tt.FieldPlaceholder}
            onChange={(e) => onChange({ thresholdCondition: e.target.value })} {...aria('thresholdCondition', `${id('thresholdCondition')}-hint`)} />
          <div id={`${id('thresholdCondition')}-hint`} className="small text-muted">
            {tt.FieldHint} {(values.thresholdCondition ?? '').trim().length}/{LIMITS.thresholdCondition[1]} {t.Characters}
          </div>
          <Err k="thresholdCondition" />
        </div>
      </fieldset>

      {/* Details content managers added to the job form (settings screen); the server checks the same rules. */}
      {jobFields.length > 0 && (
        <fieldset className="mb-4">
          <legend className="fs-5 font-RubikBold">{t.ExtraSection}</legend>
          <CustomFieldInputs fields={jobFields} values={values.customFields} idPrefix={prefix}
            errors={Object.fromEntries(jobFields.filter((f) => errors[`customFields.${f.id}`]).map((f) => [f.id, errors[`customFields.${f.id}`] === 'required' ? 'required' : 'invalid']))}
            requiredText={t.Required} invalidText={t.Invalid}
            onChange={(id, value) => onChange({ customFields: { ...(values.customFields ?? {}), [id]: value } })} />
        </fieldset>
      )}

      {showContact && <fieldset className="mb-3">
        <legend className="fs-5 font-RubikBold">{t.ContactSection}</legend>
        <div className="row">
          <div className="col-md-4">{text('contactName', t.ContactName, { required: true, max: LIMITS.contactName[1], autoComplete: 'name' })}</div>
          <div className="col-md-4">{text('contactEmail', t.ContactEmail, { required: true, type: 'email', max: LIMITS.email[1], autoComplete: 'email', dir: 'ltr' })}</div>
          <div className="col-md-4">{text('contactPhone', t.ContactPhone, { required: true, type: 'tel', max: 20, autoComplete: 'tel', dir: 'ltr' })}</div>
        </div>
      </fieldset>}
    </>
  );
};

export default SubmissionFields;
