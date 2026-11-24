import React, { useEffect, useId, useState } from 'react';
import Label from './Label';
import FieldErrorMessageComponent from './FieldErrorMessage';
import { i18n } from '../../i18n/I18n';

// A birth date as three dropdowns: year, month, day of month (the calendar picker was hard to use for a date decades
// back). Years from this year back 120; the days follow the chosen month and year, leap years included; nothing
// after today. onChange gets a Date (noon, so no time zone moves it to another day), null when all three are empty,
// or an Invalid Date while only some are chosen (the form's validation then says the date is incomplete).
interface DateInputProps {
  name: string;
  value?: Date | null;
  label?: string;
  labelClassName?: string;
  className?: string;
  error?: string | null;
  touched?: boolean;
  onChange: (date: Date | null) => void;
  onBlur?: () => void;
  required?: boolean;
}

const MAX_AGE_YEARS = 120;
const daysIn = (year: number, month: number) => new Date(year, month, 0).getDate(); // month 1–12
const partsOf = (v?: Date | null) =>
  v && !Number.isNaN(v.getTime()) ? { y: String(v.getFullYear()), m: String(v.getMonth() + 1), d: String(v.getDate()) } : { y: '', m: '', d: '' };

const DateInput: React.FC<DateInputProps> = ({ value, name, onChange, onBlur, label, labelClassName, error, required }) => {
  const uid = useId();
  const base = name || `birth-${uid}`;
  const t = i18n.getTranslations().Register;
  const locale = i18n.isRTL() ? 'he-IL' : 'en-GB';
  const [parts, setParts] = useState(partsOf(value));

  // A value set from outside (e.g. the stored date in the personal area) shows in the dropdowns.
  useEffect(() => {
    if (value && !Number.isNaN(value.getTime())) {
      const p = partsOf(value);
      if (p.y !== parts.y || p.m !== parts.m || p.d !== parts.d) setParts(p);
    }
  }, [value?.getTime?.()]);

  const today = new Date();
  const thisYear = today.getFullYear();
  const years = Array.from({ length: MAX_AGE_YEARS + 1 }, (_, i) => thisYear - i);
  const y = Number(parts.y) || 0;
  const m = Number(parts.m) || 0;
  const lastMonth = y === thisYear ? today.getMonth() + 1 : 12;
  // Without a year yet, 29 February stays available (a leap year); without a month, 31 days.
  let lastDay = m ? daysIn(y || 2000, m) : 31;
  if (y === thisYear && m === today.getMonth() + 1) lastDay = Math.min(lastDay, today.getDate());
  const monthName = (n: number) => new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2000, n - 1, 1));

  const update = (patch: Partial<typeof parts>) => {
    const next = { ...parts, ...patch };
    const ny = Number(next.y) || 0, nm = Number(next.m) || 0;
    // A month or day that no longer exists for the new choice (e.g. 31 → February, 29.2 → not a leap year) is cleared.
    if (ny === thisYear && nm > today.getMonth() + 1) next.m = '';
    const nmm = Number(next.m) || 0;
    let max = nmm ? daysIn(ny || 2000, nmm) : 31;
    if (ny === thisYear && nmm === today.getMonth() + 1) max = Math.min(max, today.getDate());
    if (Number(next.d) > max) next.d = '';
    setParts(next);
    if (!next.y && !next.m && !next.d) onChange(null);
    else if (next.y && next.m && next.d) onChange(new Date(Number(next.y), Number(next.m) - 1, Number(next.d), 12));
    else onChange(new Date(NaN));
  };

  const errorId = `${base}-error`;
  const selectProps = {
    // A red border for an error (not Bootstrap's is-invalid: its icon leaves no room for the text in a narrow select).
    className: 'form-select font-RubikRegular',
    style: { borderRadius: 8, borderColor: error ? '#dc3545' : '#98A2B3', height: 48, fontSize: 16, paddingInlineStart: 10, paddingInlineEnd: 28, backgroundPosition: 'left 8px center' } as React.CSSProperties,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    'aria-required': required || undefined,
    onBlur,
  };

  return (
    <fieldset className="max-width-20rem w-100 border-0 p-0 m-0" dir={i18n.isRTL() ? 'rtl' : 'ltr'} data-testid="birth-date">
      {label && (
        <legend className="fs-6 mb-0 float-none w-auto">
          <Label htmlFor={`${base}-year`} required={required} className={`font-RubikRegular ${labelClassName ?? ''}`}>{label}</Label>
        </legend>
      )}
      <div className="d-flex gap-2">
        <div className="flex-grow-1" style={{ flexBasis: '38%' }}>
          <label htmlFor={`${base}-year`} className="visually-hidden">{t.Year}</label>
          <select id={`${base}-year`} name={`${base}-year`} value={parts.y} onChange={(e) => update({ y: e.target.value })} {...selectProps}>
            <option value="">{t.Year}</option>
            {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
          </select>
        </div>
        <div className="flex-grow-1" style={{ flexBasis: '36%' }}>
          <label htmlFor={`${base}-month`} className="visually-hidden">{t.Month}</label>
          <select id={`${base}-month`} name={`${base}-month`} value={parts.m} onChange={(e) => update({ m: e.target.value })} {...selectProps}>
            <option value="">{t.Month}</option>
            {Array.from({ length: lastMonth }, (_, i) => i + 1).map((mm) => <option key={mm} value={mm}>{monthName(mm)}</option>)}
          </select>
        </div>
        <div className="flex-grow-1" style={{ flexBasis: '26%' }}>
          <label htmlFor={`${base}-day`} className="visually-hidden">{t.Day}</label>
          <select id={`${base}-day`} name={`${base}-day`} value={parts.d} onChange={(e) => update({ d: e.target.value })} {...selectProps}>
            <option value="">{t.Day}</option>
            {Array.from({ length: lastDay }, (_, i) => i + 1).map((dd) => <option key={dd} value={dd}>{dd}</option>)}
          </select>
        </div>
      </div>
      {error && <div id={errorId}><FieldErrorMessageComponent error={error} /></div>}
    </fieldset>
  );
};

export default DateInput;
