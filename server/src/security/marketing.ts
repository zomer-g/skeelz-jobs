/* ============================================================================
 *  Marketing mail: each candidate's consent state and the removal list (docs/marketing-consent.md). Pure: no DB.
 *
 *  States: agreed / not_agreed / removed / unknown (older accounts, copied from the old site, never asked).
 *  A removal ("please stop") always wins over an earlier "yes"; only the person's OWN new "yes" (signed in: the
 *  personal area, a form they fill while signed in, a new sign-up of that verified address) reverses it. Staff can
 *  record a removal on someone's request, never a "yes". An unverified address (a quick application, the employer
 *  form) never reverses a removal.
 *
 *  Removals are kept by a keyed hash of the address (security/addressKey.ts, its own secret since 24.11.2026), so a request from someone without an
 *  account is honoured without storing their address.
 * ========================================================================== */
import { unsubscribeSecrets } from './addressKey.js';
import crypto from 'node:crypto';

export type MarketingStatus = 'agreed' | 'not_agreed' | 'removed' | 'unknown';
export const MARKETING_STATUSES: readonly MarketingStatus[] = ['agreed', 'not_agreed', 'removed', 'unknown'];
export const isMarketingStatus = (v: unknown): v is MarketingStatus => typeof v === 'string' && (MARKETING_STATUSES as readonly string[]).includes(v);

/** How a removal came in. */
export type OptoutVia = 'link' | 'personal_area' | 'staff' | 'complaint';
export const OPTOUT_VIA: readonly OptoutVia[] = ['link', 'personal_area', 'staff', 'complaint'];

/** consent_records.source for a removal (the history shows where each answer came from). */
export const SOURCE_OF_VIA: Record<OptoutVia, string> = {
  link: 'unsubscribe_link', personal_area: 'personal_area', staff: 'staff_on_request', complaint: 'complaint',
};

export const marketingStatus = (consent: boolean | null | undefined, optoutAt: Date | string | null | undefined): MarketingStatus =>
  optoutAt ? 'removed' : consent === true ? 'agreed' : consent === false ? 'not_agreed' : 'unknown';

/** The only gate for any marketing send: an explicit "yes" and no removal. */
export const mayReceiveMarketing = (consent: boolean | null | undefined, optoutAt: Date | string | null | undefined): boolean =>
  marketingStatus(consent, optoutAt) === 'agreed';

// ---- the one-click unsubscribe link (RFC 8058): a signed token, no expiry (an old email's link must still work) ------
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface UnsubscribePayload { k: string; u?: string }

/** k = the keyed hash of the address (emailKey); u = the account id when there is one. Never the address itself. */
export const unsubscribeToken = (p: UnsubscribePayload, env?: Record<string, string | undefined>): string => {
  const body = b64url(JSON.stringify(p.u ? { k: p.k, u: p.u } : { k: p.k }));
  const mac = crypto.createHmac('sha256', unsubscribeSecrets(env)[0]).update(body).digest('base64url');
  return `${body}.${mac}`;
};

export const verifyUnsubscribeToken = (token: unknown, env?: Record<string, string | undefined>): UnsubscribePayload | null => {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  let given: Buffer;
  try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  // The current key signs; a link signed before 24.11.2026 (the legacy key) still verifies (security/addressKey.ts).
  const ok = unsubscribeSecrets(env).some((k) => {
    const expected = crypto.createHmac('sha256', k).update(body).digest();
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  if (!ok) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof p?.k !== 'string' || !/^[0-9a-f]{64}$/.test(p.k)) return null;
    if (p.u !== undefined && (typeof p.u !== 'string' || !/^[0-9a-f]{24}$/.test(p.u))) return null;
    return p.u ? { k: p.k, u: p.u } : { k: p.k };
  } catch { return null; }
};
