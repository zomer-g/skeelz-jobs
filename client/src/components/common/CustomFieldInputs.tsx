// The added fields of a form (sign-up / job), as defined on the settings screen (/settings). Text, a list to choose
// from, or a checkbox; required ones carry the usual asterisk and are checked by the server too.
import React from 'react';
import Label from './Label';
import FieldErrorMessage from './FieldErrorMessage';
import { CustomValue, CustomValues, FormField, TEXT_MAX } from '../../utils/customFields';

interface Props {
  fields: FormField[];
  values: CustomValues | undefined;
  onChange: (id: string, value: CustomValue) => void;
  /** Field id → 'required' | 'invalid' (shown only once the form was sent or the field left). */
  errors?: Record<string, string>;
  idPrefix: string;
  requiredText: string;
  invalidText: string;
}

const CustomFieldInputs: React.FC<Props> = ({ fields, values, onChange, errors = {}, idPrefix, requiredText, invalidText }) => {
  if (!fields.length) return null;
  const errorOf = (id: string) => (errors[id] === 'required' ? requiredText : errors[id] ? invalidText : '');
  return (
    <div className="row custom-fields" data-testid={`${idPrefix}-custom-fields`}>
      {fields.map((f) => {
        const id = `${idPrefix}-cf-${f.id}`;
        const err = errorOf(f.id);
        const hintId = f.help ? `${id}-hint` : undefined;
        const describedBy = [hintId, err ? `${id}-err` : undefined].filter(Boolean).join(' ') || undefined;
        const v = values?.[f.id];
        return (
          <div key={f.id} className={`${f.type === 'text' ? 'col-md-8' : 'col-md-4'} px-2 mb-3`}>
            {f.type === 'checkbox' ? (
              <div className="form-check d-flex align-items-center gap-2 pt-3 ps-3">
                <input type="checkbox" className="form-check-input float-none m-0" id={id} checked={v === true}
                  aria-required={f.required || undefined} aria-invalid={!!err || undefined} aria-describedby={describedBy}
                  onChange={(e) => onChange(f.id, e.target.checked)} />
                <label className="form-check-label font-RubikRegular" htmlFor={id}>
                  {f.required && <span className="color-attention">*</span>} {f.label}
                </label>
              </div>
            ) : (
              <>
                <Label htmlFor={id} required={f.required} className="font-RubikRegular">{f.label}</Label>
                {f.type === 'select' ? (
                  <select id={id} className="form-select border-color-grey-2 h-3rem" value={typeof v === 'string' ? v : ''}
                    aria-required={f.required || undefined} aria-invalid={!!err || undefined} aria-describedby={describedBy}
                    onChange={(e) => onChange(f.id, e.target.value)}>
                    <option value="">בחירה…</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <textarea id={id} className="form-control border-color-grey-2" rows={2} maxLength={TEXT_MAX}
                    value={typeof v === 'string' ? v : ''}
                    aria-required={f.required || undefined} aria-invalid={!!err || undefined} aria-describedby={describedBy}
                    onChange={(e) => onChange(f.id, e.target.value)} />
                )}
              </>
            )}
            {f.help && <small id={hintId} className="font-RubikRegular text-color-dark-grey d-block px-3">{f.help}</small>}
            {err && <div id={`${id}-err`}><FieldErrorMessage error={err} /></div>}
          </div>
        );
      })}
    </div>
  );
};

export default CustomFieldInputs;
