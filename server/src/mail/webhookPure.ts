/* ============================================================================
 *  Resend webhooks (pure): the signature check and what an event means for us.
 *
 *  Resend signs webhooks the Svix way (docs: resend.com/docs/dashboard/webhooks/verify-webhooks-requests):
 *  headers svix-id, svix-timestamp, svix-signature; HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the
 *  base64 secret after "whsec_"; the header holds one or more space-separated "v1,<base64>" signatures. The raw body
 *  is checked (never re-serialized JSON) and the timestamp must be within five minutes (no replays).
 * ========================================================================== */
import crypto from 'node:crypto';

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders { id?: string | null; timestamp?: string | null; signature?: string | null }

export type VerifyResult = { ok: true } | { ok: false; reason: 'no_secret' | 'missing_headers' | 'stale' | 'bad_signature' };

export const verifySvix = (secret: string | undefined, h: SvixHeaders, rawBody: Buffer | string, nowSeconds = Math.floor(Date.now() / 1000)): VerifyResult => {
  if (!secret) return { ok: false, reason: 'no_secret' };
  const id = String(h.id ?? ''); const ts = String(h.timestamp ?? ''); const sig = String(h.signature ?? '');
  if (!id || !ts || !sig || id.length > 200 || sig.length > 2000) return { ok: false, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  for (const part of sig.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    let given: Buffer;
    try { given = Buffer.from(value, 'base64'); } catch { continue; }
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
};

/** Signs like Resend does (tests and the local e2e suite only). */
export const signSvix = (secret: string, id: string, timestamp: number, rawBody: string): string => {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
};

export type SuppressReason = 'bounce' | 'complaint' | 'resend_suppressed';

export interface WebhookOutcome {
  /** The new status of our send record (mail_sends), or null to leave it. */
  status: 'delivered' | 'bounced' | 'complained' | 'suppressed' | 'delayed' | 'failed' | null;
  /** Stop sending to these recipients (bounce that is permanent, complaint, Resend's own suppression). */
  suppress: SuppressReason | null;
  emailId: string | null;
  recipients: string[];
}

/** What a Resend event means here. Unknown events change nothing. A bounce suppresses unless it says it is temporary. */
export const interpretEvent = (event: unknown): WebhookOutcome => {
  const e = (event && typeof event === 'object' ? event : {}) as Record<string, any>;
  const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, any>;
  const emailId = typeof data.email_id === 'string' ? data.email_id.slice(0, 100) : null;
  const to = Array.isArray(data.to) ? data.to : typeof data.to === 'string' ? [data.to] : [];
  const recipients = to.filter((x: unknown): x is string => typeof x === 'string').slice(0, 50);
  const base = { emailId, recipients };
  switch (e.type) {
    case 'email.delivered': return { ...base, status: 'delivered', suppress: null };
    case 'email.delivery_delayed': return { ...base, status: 'delayed', suppress: null };
    case 'email.failed': return { ...base, status: 'failed', suppress: null };
    case 'email.complained': return { ...base, status: 'complained', suppress: 'complaint' };
    case 'email.suppressed': return { ...base, status: 'suppressed', suppress: 'resend_suppressed' };
    case 'email.bounced': {
      const type = String(data.bounce?.type ?? '').toLowerCase();
      const temporary = type === 'transient' || type === 'temporary' || type === 'undetermined';
      return { ...base, status: 'bounced', suppress: temporary ? null : 'bounce' };
    }
    default: return { ...base, status: null, suppress: null };
  }
};
