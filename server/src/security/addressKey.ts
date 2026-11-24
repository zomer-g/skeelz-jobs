/* ============================================================================
 *  The keyed hash of an address for the LASTING lists (security review 24.11.2026, M3): the marketing removal list
 *  (marketing_optouts), the mail suppression list (mail_suppressions) and the unsubscribe links. These must survive
 *  any change of the sign-in / token secrets, so they have their own secret, MARKETING_OPTOUT_SECRET — long-lived,
 *  never rotated, never derived from a JWT secret (docs/marketing-consent.md "The key of the lists").
 *
 *  Before 24.11.2026 the lists used emailCode.emailKey, derived from EMAIL_CODE_SECRET || RESET_TOKEN_SECRET ||
 *  ACCESS_TOKEN_SECRET. That LEGACY key is still accepted for lookups (rows and links made before), never for new
 *  rows once MARKETING_OPTOUT_SECRET is set; at boot every row whose address the site knows is re-keyed
 *  (rekeyAddressLists). Its material can be pinned with MARKETING_OPTOUT_LEGACY_SECRET (set it to the old value
 *  before rotating those secrets, or the remaining legacy rows stop matching).
 *  Until MARKETING_OPTOUT_SECRET is set the legacy key stays the key (as before) and the boot log warns.
 * ========================================================================== */
import crypto from 'node:crypto';
import { normalizeEmail } from './emailCode.js';

type Env = Record<string, string | undefined>;
/** At least this long to count (a short value is ignored with a warning). */
export const MIN_SECRET_LENGTH = 32;

const dedicated = (env: Env = process.env): string | null => {
  const s = env.MARKETING_OPTOUT_SECRET ?? '';
  return s.length >= MIN_SECRET_LENGTH ? s : null;
};
const legacyMaterial = (env: Env = process.env): string =>
  env.MARKETING_OPTOUT_LEGACY_SECRET || env.EMAIL_CODE_SECRET || env.RESET_TOKEN_SECRET || env.ACCESS_TOKEN_SECRET || 'skeelz-dev-only';

/** Is the dedicated secret set (new rows and links use it)? */
export const hasDedicatedKey = (env?: Env): boolean => dedicated(env) !== null;

/** The key rows were made with before 24.11.2026 (= emailCode.emailKey with the same secrets). Lookups only. */
export const legacyAddressKey = (email: string, env?: Env): string =>
  crypto.createHmac('sha256', `${legacyMaterial(env)}:email-code-address`).update(normalizeEmail(email)).digest('hex');

/** The key a NEW row of the lists gets. */
export const addressKey = (email: string, env?: Env): string => {
  const d = dedicated(env);
  return d ? crypto.createHmac('sha256', `${d}:marketing-optout-address`).update(normalizeEmail(email)).digest('hex') : legacyAddressKey(email, env);
};

/** Every key an address may be stored under (the current one first): for lookups and deletes. */
export const addressKeys = (email: string, env?: Env): string[] => [...new Set([addressKey(email, env), legacyAddressKey(email, env)])];

/** The HMAC keys of the unsubscribe links: the current one signs, both verify. */
export const unsubscribeSecrets = (env?: Env): string[] => {
  const d = dedicated(env);
  const legacy = `${legacyMaterial(env)}:marketing-unsubscribe`;
  return d ? [`${d}:marketing-unsubscribe-link`, legacy] : [legacy];
};

/** The boot warning, or null when the dedicated secret is set (or ignored as too short). */
export const addressKeyWarning = (env: Env = process.env): string | null => {
  if (dedicated(env)) return null;
  if ((env.MARKETING_OPTOUT_SECRET ?? '').length) return `MARKETING_OPTOUT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters: ignored`;
  return 'MARKETING_OPTOUT_SECRET is not set: the removal and suppression lists still use the key derived from the sign-in secrets (docs/marketing-consent.md)';
};
