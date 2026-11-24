/* ============================================================================
 *  Moving the lasting lists to the dedicated key (security review 24.11.2026, M3; security/addressKey.ts).
 *  At every boot with MARKETING_OPTOUT_SECRET set: each address the site knows (accounts, quick applications,
 *  employer submissions) whose list row still has the LEGACY key gets its new key. A row whose address the site
 *  doesn't know (a removal by someone who never had anything here) stays under the legacy key and keeps matching
 *  through addressKeys. Idempotent; counts only in the log and the activity log, never an address.
 * ========================================================================== */
import { query } from '../config/db.js';
import { addressKey, addressKeyWarning, hasDedicatedKey, legacyAddressKey } from '../security/addressKey.js';
import { writeAudit } from '../security/audit.js';
import { normalizeEmail } from '../security/emailCode.js';
import { safeErrorText } from '../security/pure.js';

const TABLES = ['marketing_optouts', 'mail_suppressions'] as const;

export const rekeyAddressLists = async (): Promise<{ moved: Record<string, number> } | null> => {
  const warning = addressKeyWarning();
  if (warning) console.warn(`[address-key] ${warning}`);
  if (!hasDedicatedKey()) return null;
  try {
    const legacyRows = new Map<string, Set<string>>();
    for (const t of TABLES) legacyRows.set(t, new Set((await query<{ email_key: string }>(`SELECT email_key FROM ${t}`)).map((r) => r.email_key)));
    if (![...legacyRows.values()].some((s) => s.size)) return { moved: {} };
    const emails = await query<{ email: string }>(
      `SELECT email FROM users UNION SELECT email FROM guest_applications UNION SELECT contact_email AS email FROM job_submissions`);
    const moved: Record<string, number> = {};
    for (const t of TABLES) {
      const keys = legacyRows.get(t)!;
      let n = 0;
      for (const { email } of emails) {
        const e = normalizeEmail(email);
        const oldKey = legacyAddressKey(e), newKey = addressKey(e);
        if (oldKey === newKey || !keys.has(oldKey)) continue;
        // Already there under the new key (a newer row): the legacy one is dropped, the newer one wins.
        const r = await query(
          `WITH d AS (DELETE FROM ${t} WHERE email_key = $1 AND EXISTS (SELECT 1 FROM ${t} WHERE email_key = $2) RETURNING 1)
           UPDATE ${t} SET email_key = $2 WHERE email_key = $1 AND NOT EXISTS (SELECT 1 FROM ${t} WHERE email_key = $2) RETURNING 1`,
          [oldKey, newKey]);
        n += r.length;
        keys.delete(oldKey);
      }
      if (n) moved[t] = n;
    }
    if (Object.keys(moved).length) {
      console.log(`[address-key] re-keyed ${JSON.stringify(moved)}`);
      await writeAudit('system:migration', 'mail.address_keys_moved', null, moved);
    }
    return { moved };
  } catch (e) {
    console.error(`[address-key] re-key failed: ${safeErrorText(e)}`);
    return null;
  }
};
