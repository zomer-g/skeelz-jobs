import React from 'react';
import { i18n } from '../../i18n/I18n';
import { ApplyPolicy, CvRule, GuestMode, JobData } from '../../models/interfaces/Props.interfaces';
import { DEFAULT_APPLY_POLICY } from '../../utils/applyPolicy';

/*
 * Per-job settings as small checkboxes:
 *   sponsored · direct apply · quick apply · CV required (quick) · CV required (regular)
 * In the jobs-management table each one is its own column (the name is in the column header);
 * in the job form they are labelled checkboxes in a row (<JobFlags>).
 *
 * Direct apply (guest mode 'self') and quick apply ('quick') exclude each other; neither = 'none' (sign in).
 * Each apply setting is stored as an override only when it differs from the site-wide default
 * ("הגדרות הגשה"); a value equal to the default is stored as null, so the job keeps following the default.
 * An overridden value is marked with a dot (and a screen-reader note).
 * There is no public/private box: the status alone decides what the public sees (only Active jobs).
 */
export type FlagValues = Partial<Pick<JobData, 'isSponsored' | 'guestModeOverride' | 'quickCvOverride' | 'regularCvOverride'>>;

export interface FlagItem {
    key: 'sponsored' | 'self' | 'quick' | 'cv-quick' | 'cv-regular';
    /** Short name (column header / label). */
    text: string;
    checked: boolean;
    /** Set for this job (differs from the site default). */
    custom: boolean;
    /** Not applicable right now (CV for quick apply when quick apply is off). */
    inactive: boolean;
    change: (v: boolean) => void;
}

/** The flags of one job, in display order. `defaults` unknown → a change is stored as an explicit value. */
export const jobFlagItems = (
    values: FlagValues,
    defaults: ApplyPolicy | undefined,
    onChange: (patch: Partial<FlagValues>) => void,
    show: { isSponsored?: boolean } = { isSponsored: true },
): FlagItem[] => {
    const t = i18n.getTranslations().JobsAdmin;
    const d = defaults ?? DEFAULT_APPLY_POLICY;
    const guest: GuestMode = values.guestModeOverride ?? d.guestMode;
    const quickCv: CvRule = values.quickCvOverride ?? d.quickCv;
    const regularCv: CvRule = values.regularCvOverride ?? d.regularCv;
    // Store null when the value equals the known default (the job keeps following it).
    const store = <T extends string>(v: T, def: T | undefined): T | null => (defaults && v === def ? null : v);
    const items: FlagItem[] = [];
    if (show.isSponsored) {
        items.push({ key: 'sponsored', text: t.FlagSponsored, checked: !!values.isSponsored, custom: false, inactive: false,
            change: (v) => onChange({ isSponsored: v }) });
    }
    items.push(
        { key: 'self', text: t.FlagSelfApply, checked: guest === 'self', custom: values.guestModeOverride != null && guest === 'self', inactive: false,
            change: (v) => onChange({ guestModeOverride: store<GuestMode>(v ? 'self' : 'none', defaults?.guestMode) }) },
        { key: 'quick', text: t.FlagQuickApply, checked: guest === 'quick', custom: values.guestModeOverride != null && guest !== 'self', inactive: false,
            change: (v) => onChange({ guestModeOverride: store<GuestMode>(v ? 'quick' : 'none', defaults?.guestMode) }) },
        { key: 'cv-quick', text: t.FlagCvQuick, checked: quickCv === 'required', custom: values.quickCvOverride != null, inactive: guest !== 'quick',
            change: (v) => onChange({ quickCvOverride: store<CvRule>(v ? 'required' : 'optional', defaults?.quickCv) }) },
        { key: 'cv-regular', text: t.FlagCvRegular, checked: regularCv === 'required', custom: values.regularCvOverride != null, inactive: false,
            change: (v) => onChange({ regularCvOverride: store<CvRule>(v ? 'required' : 'optional', defaults?.regularCv) }) },
    );
    return items;
};

/** One checkbox. `labelText` is the visible text; in the table it is hidden (the column header shows it). */
export const FlagBox: React.FC<{ id: string; item: FlagItem; disabled?: boolean; accessibleName: string; showText: boolean }> = ({ id, item, disabled, accessibleName, showText }) => {
    const t = i18n.getTranslations().JobsAdmin;
    return (
        <label htmlFor={id} className={`job-flag ${item.checked ? 'is-on' : ''} ${item.custom ? 'is-custom' : ''}`}
            title={showText ? undefined : item.text}>
            <input id={id} type="checkbox" checked={item.checked} disabled={disabled || item.inactive}
                onChange={(e) => item.change(e.target.checked)} />
            {showText ? <span>{accessibleName}</span> : <span className="visually-hidden">{accessibleName}</span>}
            {item.custom && <span className="job-flag__dot" aria-hidden="true" title={t.FlagCustom} />}
            {item.custom && <span className="visually-hidden"> ({t.FlagCustom})</span>}
        </label>
    );
};

export interface JobFlagsProps {
    idPrefix: string;
    values: FlagValues;
    /** Site-wide defaults; while unknown, a change is stored as an explicit value. */
    defaults?: ApplyPolicy;
    /** Which optional boxes to show (the form already has its own sponsored box). */
    show?: { isSponsored?: boolean };
    disabled?: boolean;
    /** Accessible name of the group. */
    label: string;
    onChange: (patch: Partial<FlagValues>) => void;
}

/** The job form: all flags as labelled checkboxes in a row. */
const JobFlags: React.FC<JobFlagsProps> = ({ idPrefix, values, defaults, show, disabled, label, onChange }) => (
    <div className="job-flags" role="group" aria-label={label}>
        {jobFlagItems(values, defaults, onChange, show).map((item) => (
            <FlagBox key={item.key} id={`${idPrefix}-${item.key}`} item={item} disabled={disabled} accessibleName={item.text} showText />
        ))}
    </div>
);

export default JobFlags;
