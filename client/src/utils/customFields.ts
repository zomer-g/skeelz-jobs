// Fields content managers add to the sign-up form and the job form (settings screen /settings). The server is the
// authority (server/src/models/schemas/customFields.ts checkCustomValues); this is the same rule in the forms so
// mistakes show before sending.
export type CustomFieldType = 'text' | 'select' | 'checkbox';
export type CustomFieldForm = 'signup' | 'job';
export type CustomValue = string | boolean;
export type CustomValues = Record<string, CustomValue>;

/** What a form shows (active fields, in order). */
export interface FormField { id: string; label: string; type: CustomFieldType; options: string[]; required: boolean; help: string;
  /** Job fields from the public list: shown on the job page (an employer's edit request covers only those). */
  showOnJobPage?: boolean }
/** The full definition (settings screen). */
export interface CustomFieldDef extends FormField {
  form: CustomFieldForm; sortOrder: number; active: boolean; showOnJobPage: boolean;
  /** The Salesforce field it goes to (linked by an admin), or null. */
  sfField: string | null;
  /** Sign-up questions: when an admin turned it on; null = awaiting an admin (owner, 24.11.2026). */
  approvedAt?: string | null;
}
/** Whether an added field reaches Salesforce (server: settingsController salesforceStatuses). */
export type SalesforceFieldStatus = 'not_linked' | 'missing' | 'wrong_type' | 'not_writable' | 'ok' | 'salesforce_off' | 'unknown';

export const TEXT_MAX = 500;

let signupCache: Promise<FormField[]> | null = null;
/** GET /api/custom-fields/signup (public): the sign-up form's added questions. Once per page load; [] on failure. */
export const loadSignupCustomFields = (fresh = false): Promise<FormField[]> => {
  if (!signupCache || fresh) {
    signupCache = fetch('/api/custom-fields/signup', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b) => (Array.isArray(b?.data?.fields) ? b.data.fields as FormField[] : []))
      .catch(() => { signupCache = null; return []; });
  }
  return signupCache;
};

/** GET /api/admin/job-fields (staff who edit jobs): the job form's added fields. [] on failure. */
export const loadJobCustomFields = (): Promise<FormField[]> =>
  fetch('/api/admin/job-fields', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((b) => (Array.isArray(b?.data?.fields) ? b.data.fields as FormField[] : []))
    .catch(() => []);

/** The answers to send: every field of the form ('' / false = no answer). */
export const valuesToSend = (fields: FormField[], values: CustomValues | undefined): Record<string, CustomValue> =>
  Object.fromEntries(fields.map((f) => [f.id, values?.[f.id] ?? (f.type === 'checkbox' ? false : '')]));

/** Ids of the fields whose answer is missing or not allowed (same rule as the server). */
export const customErrors = (fields: FormField[], values: CustomValues | undefined): Record<string, 'required' | 'invalid'> => {
  const out: Record<string, 'required' | 'invalid'> = {};
  for (const f of fields) {
    const v = values?.[f.id];
    const empty = v === undefined || v === '' || v === false || (typeof v === 'string' && !v.trim());
    if (empty) { if (f.required) out[f.id] = 'required'; continue; }
    if (f.type === 'text' && (typeof v !== 'string' || v.length > TEXT_MAX)) out[f.id] = 'invalid';
    if (f.type === 'select' && (typeof v !== 'string' || !f.options.includes(v))) out[f.id] = 'invalid';
  }
  return out;
};

let publicJobFields: FormField[] = [];
let publicJobCache: Promise<FormField[]> | null = null;
/** GET /api/custom-fields/job (public): the job form's added fields, for the employer form and edit requests. */
export const loadPublicJobFields = (): Promise<FormField[]> => {
  if (!publicJobCache) {
    publicJobCache = fetch('/api/custom-fields/job', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b) => { publicJobFields = Array.isArray(b?.data?.fields) ? b.data.fields as FormField[] : []; return publicJobFields; })
      .catch(() => { publicJobCache = null; return []; });
  }
  return publicJobCache;
};
/** The last loaded copy (the employer form loads it on mount, before anything is sent). */
export const getPublicJobFields = (onlyJobPage = false): FormField[] => (onlyJobPage ? publicJobFields.filter((f) => f.showOnJobPage) : publicJobFields);
/** An employer's edit request (owner, 24.11.2026: every field): all the job form's added fields. A staff-only one (not
 *  shown on the job page) is write-only for the employer: its stored answer is never shown, so it is never required
 *  here and an empty answer means "leave it as it is" (the server does the same). */
export const STAFF_ONLY_EDIT_HINT = 'התשובה השמורה לא מוצגת כאן. ממלאים רק כדי לשנות אותה.';
export const editRequestJobFields = (): FormField[] =>
  publicJobFields.map((f) => (f.showOnJobPage ? f : { ...f, required: false, help: f.help ? `${f.help} · ${STAFF_ONLY_EDIT_HINT}` : STAFF_ONLY_EDIT_HINT }));
