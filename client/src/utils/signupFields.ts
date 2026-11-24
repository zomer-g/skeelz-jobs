// The candidate sign-up fields setting (admins, /security-management) and the Israeli ID number check.
// The server is the authority (server/src/security/pure.ts SIGNUP_FIELDS, checkProfile, normalizeIsraeliId); this is
// the same rule in the form so mistakes show before sending.
export type SignupField = 'phoneNumber' | 'citySymbol' | 'gender' | 'dateOfBirth' | 'idNumber';
export type SignupFieldMode = 'required' | 'optional' | 'hidden';
export type SignupFields = Record<SignupField, SignupFieldMode>;

/** As the server's DEFAULT_SIGNUP_FIELDS: used until the setting is read (or if it can't be). */
export const DEFAULT_SIGNUP_FIELDS: SignupFields = {
  phoneNumber: 'required', citySymbol: 'required', gender: 'required', dateOfBirth: 'required', idNumber: 'optional',
};

let cache: Promise<SignupFields> | null = null;
/** GET /api/auth/signup-fields (public). Read once per page load; falls back to the default. */
export const loadSignupFields = (fresh = false): Promise<SignupFields> => {
  if (!cache || fresh) {
    cache = fetch('/api/auth/signup-fields', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ({ ...DEFAULT_SIGNUP_FIELDS, ...(b?.data?.fields ?? {}) }))
      .catch(() => { cache = null; return { ...DEFAULT_SIGNUP_FIELDS }; });
  }
  return cache;
};

/** Israeli ID number: 5–9 digits (padded to 9 with zeros on the left), not all zeros, right check digit. */
export const israeliIdOk = (v: string): boolean => {
  const s = v.trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const id = s.padStart(9, '0');
  if (/^0+$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
};
