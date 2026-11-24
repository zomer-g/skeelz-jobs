import { query, queryOne } from '../config/db.js';
import { ApplyPolicy, DEFAULT_APPLY_POLICY, normalizeApplyPolicy } from '../models/schemas/applyPolicy.js';
import { DEFAULT_EMPLOYER_POSTING, EmployerPostingMode, normalizeEmployerPosting } from '../security/employer.js';
import { DEFAULT_SIGNUP_FIELDS, normalizeSignupFields, SignupFieldsSetting } from '../security/pure.js';

const APPLY_POLICY_KEY = 'applyPolicy';

// One process, so a small in-memory cache is safe; every write goes through here.
const CACHE_MS = 60_000;
let cached: { value: ApplyPolicy; at: number } | null = null;

/** Site-wide apply-policy defaults (today's behaviour when nothing is stored). */
export const getApplyPolicyDefaults = async (): Promise<ApplyPolicy> => {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  try {
    const row = await queryOne<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [APPLY_POLICY_KEY]);
    const value = normalizeApplyPolicy(row?.value);
    cached = { value, at: Date.now() };
    return value;
  } catch (error) {
    // A settings read must never take the job board down; fall back to the last known value.
    console.error('[settings] read failed', (error as Error).message);
    return cached?.value ?? { ...DEFAULT_APPLY_POLICY };
  }
};

/** Updates the defaults; fields left out keep their current value. */
export const updateApplyPolicyDefaults = async (patch: Partial<ApplyPolicy>, updatedBy?: string): Promise<ApplyPolicy> => {
  const current = await getApplyPolicyDefaults();
  const value = normalizeApplyPolicy(patch, current);
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [APPLY_POLICY_KEY, JSON.stringify(value), updatedBy ?? null]
  );
  cached = { value, at: Date.now() };
  // Jobs that inherit the guest mode: keep is_self_apply (Salesforce isSelfApply_cambium__c) equal to the effective mode.
  // Jobs imported from the existing site are read-only (db.ts jobs_imported_readonly); their effective mode is still
  // worked out from the defaults when they are read (jobDAL.rowToJob), and they are never pushed to Salesforce from here.
  await query(`UPDATE jobs SET is_self_apply = $1 WHERE guest_mode_override IS NULL AND is_self_apply <> $1 AND NOT imported_from_live AND legacy_state IS DISTINCT FROM 'mirror'`, [value.guestMode === 'self']);
  return value;
};

// ---- employer job posting: 'open' (the anonymous /post-job form, default) or 'account_required' -------------
const EMPLOYER_POSTING_KEY = 'employerPosting';
let cachedPosting: { value: EmployerPostingMode; at: number } | null = null;

/** Who may send a job through the employer form (security/employer.ts). Fails open to the last known value, else
 *  the default ('open' — today's behaviour), so a settings read never takes the form down. */
export const getEmployerPosting = async (): Promise<EmployerPostingMode> => {
  if (cachedPosting && Date.now() - cachedPosting.at < CACHE_MS) return cachedPosting.value;
  try {
    const row = await queryOne<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [EMPLOYER_POSTING_KEY]);
    const value = normalizeEmployerPosting(row?.value);
    cachedPosting = { value, at: Date.now() };
    return value;
  } catch (error) {
    console.error('[settings] read failed', (error as Error).message);
    return cachedPosting?.value ?? DEFAULT_EMPLOYER_POSTING;
  }
};

export const updateEmployerPosting = async (mode: EmployerPostingMode, updatedBy?: string): Promise<EmployerPostingMode> => {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [EMPLOYER_POSTING_KEY, JSON.stringify({ mode }), updatedBy ?? null]
  );
  cachedPosting = { value: mode, at: Date.now() };
  return mode;
};

// ---- sign-up fields: which candidate fields are required / optional / hidden (security/pure.ts SIGNUP_FIELDS) ----
const SIGNUP_FIELDS_KEY = 'signupFields';
let cachedSignup: { value: SignupFieldsSetting; at: number } | null = null;

/** The sign-up fields setting. Fails to the last known value, else the default (today's form), so a settings read
 *  never takes sign-up down. Both the form and the server's checks read this. */
export const getSignupFields = async (): Promise<SignupFieldsSetting> => {
  if (cachedSignup && Date.now() - cachedSignup.at < CACHE_MS) return cachedSignup.value;
  try {
    const row = await queryOne<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [SIGNUP_FIELDS_KEY]);
    const value = normalizeSignupFields(row?.value);
    cachedSignup = { value, at: Date.now() };
    return value;
  } catch (error) {
    console.error('[settings] read failed', (error as Error).message);
    return cachedSignup?.value ?? { ...DEFAULT_SIGNUP_FIELDS };
  }
};

/** Updates the setting; fields left out keep their current value. */
export const updateSignupFields = async (patch: Partial<SignupFieldsSetting>, updatedBy?: string): Promise<SignupFieldsSetting> => {
  const value = normalizeSignupFields(patch, await getSignupFields());
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [SIGNUP_FIELDS_KEY, JSON.stringify(value), updatedBy ?? null]
  );
  cachedSignup = { value, at: Date.now() };
  return value;
};
