/* ============================================================================
 *  The marketing mailing list (SMOOV) — ONE gate for every push and every removal (security review 24.11.2026, M2;
 *  docs/marketing-consent.md). SMOOV stays off unless the owner turns it on (ENABLE_SMOOVE); off → nothing is sent.
 *
 *  - Push: only an explicit "yes" AND the address is not on the removal list (mayReceiveMarketing with the
 *    marketing_optouts row). An unverified form (quick application) never clears a removal, so such a "yes" for a
 *    removed address pushes nothing.
 *  - Removal (personal area "no", the unsubscribe link of an account, staff on request, a spam complaint): the address
 *    is also unsubscribed in SMOOV. A link without an account carries only the keyed hash, so there is no address to
 *    send; SMOOV's own unsubscribe link covers its mail.
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { queryOne } from '../config/db.js';
import { addressKeys } from '../security/addressKey.js';
import { mayReceiveMarketing } from '../security/marketing.js';
import { safeErrorText } from '../security/pure.js';
import * as smooveService from './smooveService.js';

/** When the address was put on the removal list, or null. */
export const removedAt = async (email: string): Promise<Date | null> =>
  (await queryOne<{ created_at: Date }>(`SELECT min(created_at) AS created_at FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [addressKeys(email)]))?.created_at ?? null;

/** May this address be put on the mailing list now? An explicit "yes" and no removal. */
export const mayPushToList = async (email: string, consent: boolean | null | undefined): Promise<boolean> =>
  consent === true && mayReceiveMarketing(true, await removedAt(email));

/** A removal reaches SMOOV too (when it is on). Never throws; logs a status code only. */
export const removeFromList = async (email: string | null | undefined): Promise<void> => {
  if (!email || !appConfig.smoove.enableSmoove) return;
  try {
    await smooveService.unsubscribeSmooveContact(email);
  } catch (e) {
    console.error(`[smoove] removal failed: ${safeErrorText(e)}`);
  }
};
