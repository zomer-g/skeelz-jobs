/* ============================================================================
 *  Service emails through templates edited on the site (docs/mail.md).
 *
 *  sendMail(kind, to, values): the event on? → the published template (else the default text in catalog.ts; also
 *  when the published one cannot be rendered) → the address not suppressed (bounce / complaint) → Resend
 *  (emailService.deliver, which sends only when email is on). Every attempt is one row in mail_sends: the kind, the
 *  status and Resend's message id. Never the address, never the text. Never throws: the action that triggered an
 *  email never fails because of it.
 * ========================================================================== */
import { query, queryOne } from '../config/db.js';
import { emailKey, emailCodeEnabled } from '../security/emailCode.js';
import { safeErrorText } from '../security/pure.js';
import { deliver, EmailSendError, emailConfig } from '../services/emailService.js';
import { MAIL_KINDS, MailKind, mailKind } from './catalog.js';
import { renderTemplate, RenderedMail, SERVICE_FOOTER, validateTemplate } from './render.js';
import type { SuppressReason } from './webhookPure.js';

export type SendStatus = 'sent' | 'off' | 'disabled' | 'suppressed' | 'failed' | 'no_recipient';
export interface SendResult { status: SendStatus; id?: string; error?: string }

// ---- event state + published templates (cached; one process, every write goes through here) -------------------
interface EventRow { kind: string; enabled: boolean; published_version: string | null; updated_at: Date; updated_by: string | null }
interface VersionRow { id: string; kind: string; subject: string; body: string; created_by: string; created_at: Date; published_at: Date | null }

const CACHE_MS = 30_000;
let cache: { at: number; events: Map<string, EventRow>; templates: Map<string, VersionRow> } | null = null;
export const invalidateMailCache = () => { cache = null; };

const load = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const events = await query<EventRow>(`SELECT kind, enabled, published_version::text AS published_version, updated_at, updated_by FROM mail_events`);
  const ids = events.map((e) => e.published_version).filter(Boolean);
  const versions = ids.length
    ? await query<VersionRow>(`SELECT id::text AS id, kind, subject, body, created_by, created_at, published_at FROM mail_template_versions WHERE id = ANY($1::bigint[])`, [ids])
    : [];
  cache = {
    at: Date.now(),
    events: new Map(events.map((e) => [e.kind, e])),
    templates: new Map(versions.map((v) => [v.kind, v])),
  };
  return cache;
};

/** Whether the event cannot be turned off right now (the sign-in code while email sign-in is on). */
export const isLocked = (k: MailKind) => !k.canDisable && emailCodeEnabled();

export const isEnabled = async (k: MailKind): Promise<boolean> => {
  if (isLocked(k)) return true;
  try {
    const c = await load();
    return c.events.get(k.kind)?.enabled ?? k.defaultEnabled;
  } catch (e) {
    console.error('[mail] state read failed', safeErrorText(e));
    return k.defaultEnabled;
  }
};

const publishedOf = async (kind: string): Promise<VersionRow | null> => {
  try { return (await load()).templates.get(kind) ?? null; } catch (e) {
    console.error('[mail] template read failed', safeErrorText(e));
    return null;
  }
};

/** The finished email for a kind and values: the published template, or the default text if there is none / it fails. */
export const composeMail = async (k: MailKind, values: Record<string, unknown>): Promise<RenderedMail & { version: string | null }> => {
  const v = await publishedOf(k.kind);
  if (v) {
    try {
      if (validateTemplate(k, v.subject, v.body).length === 0) return { ...renderTemplate(v.subject, v.body, values, { footer: SERVICE_FOOTER }), version: v.id };
      console.error(`[mail] published template invalid kind=${k.kind} version=${v.id}; default used`);
    } catch (e) {
      console.error(`[mail] render failed kind=${k.kind} version=${v.id}; default used`, safeErrorText(e));
    }
  }
  return { ...renderTemplate(k.defaultSubject, k.defaultBody, values, { footer: SERVICE_FOOTER }), version: null };
};

// ---- suppression (bounces, complaints) ---------------------------------------------------------------------------
export const isSuppressed = async (to: string): Promise<boolean> => {
  try {
    return !!(await queryOne(`SELECT 1 FROM mail_suppressions WHERE email_key = $1`, [emailKey(to)]));
  } catch (e) {
    console.error('[mail] suppression read failed', safeErrorText(e));
    return false;
  }
};

export const suppress = async (address: string, reason: SuppressReason): Promise<void> => {
  await query(
    `INSERT INTO mail_suppressions (email_key, reason) VALUES ($1, $2)
     ON CONFLICT (email_key) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now(), events = mail_suppressions.events + 1`,
    [emailKey(address), reason]);
};

/** Removes an address from the suppression list (a staff member fixed it). true when it was there. */
export const unsuppress = async (address: string): Promise<boolean> =>
  (await query(`DELETE FROM mail_suppressions WHERE email_key = $1 RETURNING 1`, [emailKey(address)])).length > 0;

const record = async (kind: string, status: SendStatus, resendId?: string, error?: string, version?: string | null) => {
  try {
    await query(`INSERT INTO mail_sends (kind, status, resend_id, error, template_version) VALUES ($1, $2, $3, $4, $5)`,
      [kind, status, resendId ?? null, error ?? null, version ?? null]);
  } catch (e) {
    console.error('[mail] send record failed', safeErrorText(e));
  }
};

/**
 * Sends one service email of a kind. Never throws. `idempotencyKey` (no personal data) makes a retry of the same
 * request not send twice. With `force`, a turned-off event still sends (only the editor's own test send).
 */
export const sendMail = async (kind: string, to: string | null | undefined, values: Record<string, unknown>,
  opts: { idempotencyKey?: string; override?: { subject: string; body: string }; skipRecord?: boolean } = {}): Promise<SendResult> => {
  const k = mailKind(kind);
  if (!k) { console.error(`[mail] unknown kind ${String(kind).slice(0, 40)}`); return { status: 'failed', error: 'unknown_kind' }; }
  try {
    if (!opts.override && !(await isEnabled(k))) return { status: 'disabled' };
    if (!to) {
      // The team's inbox (APPLICATION_NOTIFICATION_EMAIL) not set: an ON event that cannot go out is counted, so the
      // screen shows it instead of a silent nothing. Other kinds without an address (none expected) are not counted.
      if (k.audience === 'team' && !opts.skipRecord) await record(k.kind, 'no_recipient');
      return { status: 'no_recipient' };
    }
    if (await isSuppressed(to)) {
      console.info(`[mail] not sent: suppressed kind=${k.kind}`);
      if (!opts.skipRecord) await record(k.kind, 'suppressed');
      return { status: 'suppressed' };
    }
    const mail = opts.override
      ? { ...renderTemplate(opts.override.subject, opts.override.body, values, { footer: SERVICE_FOOTER }), version: null }
      : await composeMail(k, values);
    const r = await deliver({ to, subject: mail.subject, text: mail.text, html: mail.html, kind: k.kind, idempotencyKey: opts.idempotencyKey });
    const status: SendStatus = r.sent ? 'sent' : 'off';
    if (!opts.skipRecord) await record(k.kind, status, r.id, undefined, mail.version);
    return { status, id: r.id };
  } catch (e) {
    const code = e instanceof EmailSendError ? `${e.code}${e.status ? `:${e.status}` : ''}` : 'em1';
    if (!(e instanceof EmailSendError)) console.error(`[mail] send failed kind=${k.kind}`, safeErrorText(e));
    if (!opts.skipRecord) await record(k.kind, 'failed', undefined, code);
    return { status: 'failed', error: code };
  }
};

// ---- the staff screen ----------------------------------------------------------------------------------------------
export interface VersionView { id: string; subject: string; body: string; createdBy: string; createdAt: Date; publishedAt: Date | null; isPublished: boolean }

export const listEvents = async () => {
  const c = await load();
  return MAIL_KINDS.map((k) => {
    const row = c.events.get(k.kind);
    const v = c.templates.get(k.kind);
    return {
      kind: k.kind, audience: k.audience, label: k.label, when: k.when,
      enabled: isLocked(k) ? true : row?.enabled ?? k.defaultEnabled,
      canDisable: k.canDisable, locked: isLocked(k),
      published: v ? { id: v.id, at: v.published_at, by: v.created_by } : null,
      updatedAt: row?.updated_at ?? null,
    };
  });
};

export const versionsOf = async (kind: string): Promise<VersionView[]> => {
  const c = await load();
  const current = c.events.get(kind)?.published_version ?? null;
  const rows = await query<VersionRow>(
    `SELECT id::text AS id, kind, subject, body, created_by, created_at, published_at FROM mail_template_versions
      WHERE kind = $1 ORDER BY id DESC LIMIT 50`, [kind]);
  return rows.map((r) => ({ id: r.id, subject: r.subject, body: r.body, createdBy: r.created_by, createdAt: r.created_at,
    publishedAt: r.published_at, isPublished: r.id === current }));
};

export const saveVersion = async (kind: string, subject: string, body: string, by: string): Promise<string> => {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO mail_template_versions (kind, subject, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [kind, subject, body, by]);
  return row!.id;
};

/** Publishes a saved version of that kind (null → back to the default text). false when the version is not this kind's. */
export const publishVersion = async (kind: string, versionId: string | null, by: string): Promise<boolean> => {
  if (versionId !== null) {
    const v = await queryOne(`SELECT 1 FROM mail_template_versions WHERE id = $1::bigint AND kind = $2`, [versionId, kind]);
    if (!v) return false;
    await query(`UPDATE mail_template_versions SET published_at = COALESCE(published_at, now()) WHERE id = $1::bigint`, [versionId]);
  }
  const k = mailKind(kind)!;
  await query(
    `INSERT INTO mail_events (kind, enabled, published_version, updated_by) VALUES ($1, $2, $3::bigint, $4)
     ON CONFLICT (kind) DO UPDATE SET published_version = EXCLUDED.published_version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kind, k.defaultEnabled, versionId, by]);
  invalidateMailCache();
  return true;
};

export const setEnabled = async (kind: string, enabled: boolean, by: string): Promise<void> => {
  await query(
    `INSERT INTO mail_events (kind, enabled, updated_by, enabled_at) VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END)
     ON CONFLICT (kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now(),
       enabled_at = CASE WHEN EXCLUDED.enabled AND NOT mail_events.enabled THEN now() ELSE mail_events.enabled_at END`,
    [kind, enabled, by]);
  invalidateMailCache();
};

/** Counts per kind and status over the last days (no addresses, no text). */
export const sendStats = async (days = 30) => {
  const rows = await query<{ kind: string; status: string; n: string }>(
    `SELECT kind, status, count(*)::text AS n FROM mail_sends WHERE created_at > now() - make_interval(days => $1) GROUP BY kind, status`, [days]);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.kind] ??= {})[r.status] = Number(r.n);
  return out;
};

export const suppressionCount = async (): Promise<number> =>
  Number((await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM mail_suppressions`))?.n ?? 0);

export const emailIsOn = () => emailConfig().ready;
export const webhookConfigured = () => !!process.env.RESEND_WEBHOOK_SECRET;

// ---- webhooks ------------------------------------------------------------------------------------------------------
/** true the first time this Svix message id is seen (replays and retries change nothing twice). */
export const firstDelivery = async (svixId: string): Promise<boolean> =>
  (await query(`INSERT INTO mail_webhook_events (svix_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [svixId.slice(0, 200)])).length > 0;

export const updateSendStatus = async (resendId: string, status: string): Promise<number> =>
  (await query(`UPDATE mail_sends SET status = $2, updated_at = now() WHERE resend_id = $1 RETURNING 1`, [resendId, status])).length;

/** Housekeeping: send records and webhook ids are kept for a limited time (docs/mail.md). */
export const SEND_RECORD_DAYS = 180;
export const purgeMailRecords = async (): Promise<number> => {
  const a = await query(`DELETE FROM mail_sends WHERE created_at < now() - make_interval(days => $1) RETURNING 1`, [SEND_RECORD_DAYS]);
  await query(`DELETE FROM mail_webhook_events WHERE received_at < now() - interval '14 days'`);
  return a.length;
};
