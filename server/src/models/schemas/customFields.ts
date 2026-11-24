/* ---------------------------------------------------------------------------
 *  Added fields ("שדות נוספים", settings screen /settings, owner 23.11.2026): content managers add their own
 *  questions to the candidate sign-up form ('signup') and to the staff job form ('job').
 *
 *  A definition: label, type (text / select / checkbox), the options of a select, required or optional, order,
 *  active, and for a job field whether the job page shows it. Values are stored by the field's id (users.custom_fields /
 *  jobs.custom_fields, jsonb), so renaming a label never loses an answer. A field is never deleted: it is turned off
 *  (not asked, not accepted, answers kept and still shown to staff).
 *
 *  Pure (no DB): the server's checks, unit-tested in test/customFields.test.mjs. The client has the same rules for
 *  showing mistakes before sending (client/src/utils/customFields.ts); the server is the authority.
 *  Never pushed to Salesforce (docs/salesforce.md), never shown to employers (docs/employers.md).
 * ------------------------------------------------------------------------- */

export const CUSTOM_FIELD_FORMS = ['signup', 'job'] as const;
export type CustomFieldForm = typeof CUSTOM_FIELD_FORMS[number];
export const CUSTOM_FIELD_TYPES = ['text', 'select', 'checkbox'] as const;
export type CustomFieldType = typeof CUSTOM_FIELD_TYPES[number];

export const CUSTOM_FIELD_LIMITS = {
  /** Fields per form (active and off together). */
  perForm: 30,
  label: { min: 2, max: 80 },
  /** Options of a select field. */
  options: { min: 2, max: 30 },
  option: { min: 1, max: 80 },
  /** A text answer. */
  text: { max: 500 },
  /** Hint under the field. */
  help: { max: 200 },
} as const;

export interface CustomFieldDef {
  id: string;
  form: CustomFieldForm;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
  sortOrder: number;
  active: boolean;
  /** Job fields only: the answer is shown on the public job page. Sign-up answers are never public. */
  showOnJobPage: boolean;
  help: string;
  /** The Salesforce field it goes to (Contact for a sign-up field, the Position Case for a job field), linked by an
   *  admin; null = not sent. Sent only when the org has it as a writable field of a fitting type. */
  sfField: string | null;
}

/** A stored or sent answer: text / the chosen option (string), or a checkbox (boolean). */
export type CustomValue = string | boolean;
export type CustomValues = Record<string, CustomValue>;

export const isCustomFieldForm = (v: unknown): v is CustomFieldForm => (CUSTOM_FIELD_FORMS as readonly unknown[]).includes(v);
const isType = (v: unknown): v is CustomFieldType => (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(v);

/** Plain text on one line: tags and control characters removed, spaces collapsed, trimmed. */
export const plainLine = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
/** Plain text that may keep line breaks (a text answer). */
const plainText = (v: unknown): string =>
  typeof v === 'string'
    ? v.replace(/<[^>]*>/g, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
      .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';

export const DEFINITION_KEYS = ['label', 'type', 'options', 'required', 'sortOrder', 'active', 'showOnJobPage', 'help'] as const;
export type DefinitionKey = typeof DEFINITION_KEYS[number];

export type DefinitionCheck =
  | { ok: true; value: Omit<CustomFieldDef, 'id' | 'form'> }
  | { ok: false; error: string };

/**
 * A new definition (no `base`) or a change to one (`base` = the stored definition; keys left out keep their value).
 * Unknown keys are refused, so a typo never passes silently. The type of an existing field never changes (its answers
 * were given for that type). Error codes: unknown_key, bad_label, bad_type, bad_options, bad_help, bad_value, type_fixed.
 */
export const checkDefinition = (raw: unknown, base?: Omit<CustomFieldDef, 'id' | 'form'>): DefinitionCheck => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bad_value' };
  const src = raw as Record<string, unknown>;
  const L = CUSTOM_FIELD_LIMITS;
  for (const k of Object.keys(src)) if (!(DEFINITION_KEYS as readonly string[]).includes(k)) return { ok: false, error: 'unknown_key' };
  const out = base ? { ...base, options: [...base.options] } : {
    label: '', type: 'text' as CustomFieldType, options: [] as string[], required: false, sortOrder: 0, active: true, showOnJobPage: false, help: '',
    sfField: null as string | null,
  };
  if (src.type !== undefined) {
    if (!isType(src.type)) return { ok: false, error: 'bad_type' };
    if (base && src.type !== base.type) return { ok: false, error: 'type_fixed' };
    out.type = src.type;
  } else if (!base) return { ok: false, error: 'bad_type' };
  if (src.label !== undefined || !base) {
    const label = plainLine(src.label);
    if (label.length < L.label.min || label.length > L.label.max) return { ok: false, error: 'bad_label' };
    out.label = label;
  }
  if (src.help !== undefined) {
    const help = plainLine(src.help);
    if (help.length > L.help.max) return { ok: false, error: 'bad_help' };
    out.help = help;
  }
  for (const k of ['required', 'active', 'showOnJobPage'] as const) {
    if (src[k] === undefined) continue;
    if (typeof src[k] !== 'boolean') return { ok: false, error: 'bad_value' };
    out[k] = src[k] as boolean;
  }
  if (src.sortOrder !== undefined) {
    const n = src.sortOrder;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1000) return { ok: false, error: 'bad_value' };
    out.sortOrder = n;
  }
  if (src.options !== undefined) {
    if (!Array.isArray(src.options)) return { ok: false, error: 'bad_options' };
    const opts = src.options.map(plainLine);
    if (opts.some((o) => o.length < L.option.min || o.length > L.option.max)) return { ok: false, error: 'bad_options' };
    if (new Set(opts).size !== opts.length) return { ok: false, error: 'bad_options' };
    out.options = opts;
  }
  if (out.type === 'select') {
    if (out.options.length < L.options.min || out.options.length > L.options.max) return { ok: false, error: 'bad_options' };
  } else if (out.options.length) {
    return { ok: false, error: 'bad_options' };
  }
  return { ok: true, value: out };
};

export type ValuesCheck = { ok: true; values: Record<string, CustomValue | null> } | { ok: false; bad: string[] };

/**
 * A candidate's (or a job's) answers against the form's definitions. Only ACTIVE fields are taken; any other key is
 * dropped (allowlist). With `requireAll` (a sign-up, a new job) every active required field must be answered; without
 * it only the given ones are checked, and an empty answer clears an optional field (null) but never a required one.
 * A required checkbox must be ticked. Returns the field ids on failure (never the values).
 */
export const checkCustomValues = (defs: readonly CustomFieldDef[], raw: unknown, opts: { requireAll?: boolean } = {}): ValuesCheck => {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const values: Record<string, CustomValue | null> = {};
  const bad: string[] = [];
  for (const d of defs) {
    if (!d.active) continue;
    const has = Object.prototype.hasOwnProperty.call(src, d.id);
    const v = src[d.id];
    const empty = !has || v === undefined || v === null || v === '' || (d.type === 'checkbox' && v === false);
    if (empty) {
      if (d.required && (opts.requireAll || has)) bad.push(d.id);
      else if (has) values[d.id] = d.type === 'checkbox' ? false : null;
      continue;
    }
    switch (d.type) {
      case 'text': {
        const t = plainText(v);
        if (typeof v !== 'string' || t.length > CUSTOM_FIELD_LIMITS.text.max) bad.push(d.id);
        else if (!t) { if (d.required) bad.push(d.id); else values[d.id] = null; }
        else values[d.id] = t;
        break;
      }
      case 'select':
        if (typeof v === 'string' && d.options.includes(v)) values[d.id] = v; else bad.push(d.id);
        break;
      case 'checkbox':
        if (v === true) values[d.id] = true; else bad.push(d.id);
        break;
    }
  }
  return bad.length ? { ok: false, bad } : { ok: true, values };
};

/** The stored answers after a change: null removes an answer, anything else replaces it. */
export const mergeCustomValues = (stored: unknown, patch: Record<string, CustomValue | null>): CustomValues => {
  const out: CustomValues = { ...asCustomValues(stored) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === false) delete out[k]; else out[k] = v;
  }
  return out;
};

/** Whatever the DB holds → only string / boolean answers under string keys. */
export const asCustomValues = (v: unknown): CustomValues => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: CustomValues = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string' || typeof x === 'boolean') out[k] = x;
  return out;
};

/** An active required field without an answer (a candidate asked to complete their details). */
export const missingRequired = (defs: readonly CustomFieldDef[], stored: unknown): string[] => {
  const v = asCustomValues(stored);
  return defs.filter((d) => d.active && d.required && (v[d.id] === undefined || v[d.id] === '' || v[d.id] === false)).map((d) => d.id);
};

export interface ShownValue { id: string; label: string; value: string; active: boolean }

/**
 * Answers as staff (and, for job fields marked so, the job page) read them: label + text, in the form's order.
 * `onlyJobPage`: only active fields shown on the job page (public). A checkbox shows as "כן".
 */
export const shownValues = (defs: readonly CustomFieldDef[], stored: unknown, opts: { onlyJobPage?: boolean } = {}): ShownValue[] => {
  const v = asCustomValues(stored);
  return [...defs]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .filter((d) => v[d.id] !== undefined && v[d.id] !== '' && v[d.id] !== false)
    .filter((d) => !opts.onlyJobPage || (d.form === 'job' && d.active && d.showOnJobPage))
    .map((d) => ({ id: d.id, label: d.label, value: v[d.id] === true ? 'כן' : String(v[d.id]), active: d.active }));
};

/** What a form shows (public for the sign-up form): active fields in order, without staff-only flags. */
export const formFields = (defs: readonly CustomFieldDef[]) =>
  [...defs].filter((d) => d.active).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map(({ id, label, type, options, required, help }) => ({ id, label, type, options, required, help }));

/** The definition keys that changed (for the activity log: names, never answers). */
export const changedKeys = (before: Omit<CustomFieldDef, 'id' | 'form'>, after: Omit<CustomFieldDef, 'id' | 'form'>): DefinitionKey[] =>
  DEFINITION_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

/** Field ids the check refused → the form's error codes (`customFields.<id>`: required / invalid). */
export const errorCodesOf = (defs: readonly CustomFieldDef[], raw: unknown, bad: readonly string[]): Record<string, 'required' | 'invalid'> => {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, 'required' | 'invalid'> = {};
  for (const id of bad) {
    const v = src[id];
    out[`customFields.${id}`] = v === undefined || v === null || v === '' || v === false || (typeof v === 'string' && !plainLine(v)) ? 'required' : 'invalid';
  }
  return out;
};

/** The answers that differ from the job's current ones (an employer's edit request): id → the new answer (null = removed). */
export const changedValues = (current: unknown, patch: Record<string, CustomValue | null>): Record<string, CustomValue | null> => {
  const cur = asCustomValues(current);
  const out: Record<string, CustomValue | null> = {};
  for (const [id, v] of Object.entries(patch)) {
    const now = cur[id] === undefined || cur[id] === false ? null : cur[id];
    const next = v === false ? null : v;
    if (now !== next) out[id] = next;
  }
  return out;
};

// ---- Salesforce link (admins; docs/settings.md "Salesforce") ----------------------------------------------------
/** A custom field's API name (…__c): never a standard field, so an added field can't overwrite one. */
export const SF_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,36}__c$/;
/** Salesforce field types an answer fits. */
export const SF_TYPES: Record<CustomFieldType, readonly string[]> = {
  text: ['string', 'textarea'],
  select: ['picklist', 'string', 'textarea'],
  checkbox: ['boolean'],
};
export const salesforceObjectOf = (form: CustomFieldForm): 'Contact' | 'Case' => (form === 'signup' ? 'Contact' : 'Case');
