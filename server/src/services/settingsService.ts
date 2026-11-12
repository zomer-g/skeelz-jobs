import { query, queryOne } from '../config/db.js';
import { ApplyPolicy, DEFAULT_APPLY_POLICY, normalizeApplyPolicy } from '../models/schemas/applyPolicy.js';

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
  return value;
};
