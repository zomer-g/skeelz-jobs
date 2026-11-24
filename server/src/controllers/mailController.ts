/* ============================================================================
 *  The mail screen (/mail-management, content managers and admins) and Resend's webhook (docs/mail.md).
 *
 *    GET  /admin/mail                              the events: on/off, template status, send counts
 *    GET  /admin/mail/kinds/:kind                  one event: parameters, default text, current text, versions
 *    POST /admin/mail/kinds/:kind/versions         { subject, body, publish? } save a new version (and publish it)
 *    POST /admin/mail/kinds/:kind/versions/:id/publish   publish a saved version (also an older one: "restore")
 *    POST /admin/mail/kinds/:kind/reset            back to the default text
 *    PUT  /admin/mail/kinds/:kind/enabled          { enabled } turn the event on / off
 *    POST /admin/mail/preview                      { kind, subject, body } → the email with sample values
 *    POST /admin/mail/test                         { kind, subject, body } → sent ONLY to the editor's own address,
 *                                                  with sample values, never a real person's data
 *    POST /admin/mail/suppressions/remove          { email } send again to an address that bounced
 *    POST /webhooks/resend                         Resend's events (signed, see webhookPure.ts)
 *
 *  Logged: mail.template_saved / mail.template_published / mail.template_reset / mail.event_enabled /
 *  mail.event_disabled / mail.test_sent / mail.suppression_removed (kind, version ids; never the text), and
 *  mail.suppressed from the webhook (a hash of the address only).
 * ========================================================================== */
import appConfig from '../config/appConfig.js';
import { NextFunction, Request, Response } from 'express';
import { actorOf, writeAudit } from '../security/audit.js';
import { emailKey, isValidEmail, normalizeEmail } from '../security/emailCode.js';
import { safeErrorText } from '../security/pure.js';
import { AUDIENCE_LABELS, mailKind, sampleValues } from '../mail/catalog.js';
import { MAX_BODY, MAX_SUBJECT, renderTemplate, SERVICE_FOOTER, validateTemplate } from '../mail/render.js';
import * as mail from '../mail/mailService.js';
import { interpretEvent, verifySvix } from '../mail/webhookPure.js';
import { removeByComplaint } from './marketingController.js';

const kindOr404 = (req: Request, res: Response) => {
  const k = mailKind(req.params.kind ?? req.body?.kind);
  if (!k) { res.status(404).json({ message: 'Unknown email kind', code: 'mail_kind_unknown' }); return null; }
  return k;
};
const textOf = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max + 1) : '');
const invalid = (res: Response, errors: string[]) => res.status(400).json({ message: 'The template is not valid', code: 'mail_template_invalid', errors });

export const overview = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: {
      emailOn: mail.emailIsOn(),
      webhookConfigured: mail.webhookConfigured(),
      teamInboxSet: !!appConfig.applicationNotificationEmail,
      events: await mail.listEvents(),
      audiences: AUDIENCE_LABELS,
      stats: await mail.sendStats(30),
      suppressed: await mail.suppressionCount(),
    } });
  } catch (e) { next(e); }
};

export const getKind = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const versions = await mail.versionsOf(k.kind);
    const published = versions.find((v) => v.isPublished) ?? null;
    res.json({ data: {
      kind: k.kind, label: k.label, when: k.when, audience: k.audience,
      params: k.params, required: k.required ?? [],
      default: { subject: k.defaultSubject, body: k.defaultBody },
      current: published ? { subject: published.subject, body: published.body, versionId: published.id } : { subject: k.defaultSubject, body: k.defaultBody, versionId: null },
      versions,
      limits: { subject: MAX_SUBJECT, body: MAX_BODY },
    } });
  } catch (e) { next(e); }
};

export const saveVersion = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const subject = textOf(req.body?.subject, MAX_SUBJECT); const body = textOf(req.body?.body, MAX_BODY);
    const errors = validateTemplate(k, subject, body);
    if (errors.length) return invalid(res, errors);
    const by = actorOf(req);
    const id = await mail.saveVersion(k.kind, subject, body, by);
    void writeAudit(by, 'mail.template_saved', k.kind, { version: id });
    if (req.body?.publish === true) {
      await mail.publishVersion(k.kind, id, by);
      void writeAudit(by, 'mail.template_published', k.kind, { version: id });
    }
    res.status(201).json({ data: { id, published: req.body?.publish === true } });
  } catch (e) { next(e); }
};

export const publish = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const id = String(req.params.id ?? '');
    if (!/^\d{1,18}$/.test(id)) return res.status(404).json({ message: 'No such version', code: 'mail_version_unknown' });
    // A version saved before a rule changed is checked again before it goes live.
    const v = (await mail.versionsOf(k.kind)).find((x) => x.id === id);
    if (v) { const errors = validateTemplate(k, v.subject, v.body); if (errors.length) return invalid(res, errors); }
    const by = actorOf(req);
    if (!(await mail.publishVersion(k.kind, id, by))) return res.status(404).json({ message: 'No such version', code: 'mail_version_unknown' });
    void writeAudit(by, 'mail.template_published', k.kind, { version: id });
    res.json({ data: { published: id } });
  } catch (e) { next(e); }
};

export const reset = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const by = actorOf(req);
    await mail.publishVersion(k.kind, null, by);
    void writeAudit(by, 'mail.template_reset', k.kind, null);
    res.json({ data: { published: null } });
  } catch (e) { next(e); }
};

export const setEnabled = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ message: 'enabled (true / false) is required', code: 'bad_request' });
    const enabled = req.body.enabled as boolean;
    if (!enabled && mail.isLocked(k)) {
      return res.status(409).json({ message: 'The sign-in code email cannot be turned off while sign-in by email code is on', code: 'mail_event_locked' });
    }
    const by = actorOf(req);
    await mail.setEnabled(k.kind, enabled, by);
    void writeAudit(by, enabled ? 'mail.event_enabled' : 'mail.event_disabled', k.kind, null);
    res.json({ data: { kind: k.kind, enabled } });
  } catch (e) { next(e); }
};

export const preview = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const subject = textOf(req.body?.subject, MAX_SUBJECT); const body = textOf(req.body?.body, MAX_BODY);
    const errors = validateTemplate(k, subject, body);
    const r = renderTemplate(subject, body, sampleValues(k), { footer: SERVICE_FOOTER });
    res.json({ data: { errors, ...r } });
  } catch (e) { next(e); }
};

// The editor's own test sends: a few an hour per person (in memory; one process).
const TEST_PER_HOUR = 10;
const testSends = new Map<string, number[]>();

export const testSend = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const k = kindOr404(req, res); if (!k) return;
    const to = req.authUser?.email;
    if (!to) return res.status(403).json({ message: 'No address', code: 'mail_no_address' });
    const subject = textOf(req.body?.subject, MAX_SUBJECT); const body = textOf(req.body?.body, MAX_BODY);
    const errors = validateTemplate(k, subject, body);
    if (errors.length) return invalid(res, errors);
    const who = req.authUser!.id;
    const now = Date.now();
    const recent = (testSends.get(who) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= TEST_PER_HOUR) {
      res.setHeader('Retry-After', String(Math.ceil((3_600_000 - (now - recent[0])) / 1000)));
      return res.status(429).json({ message: 'Too many test emails this hour', code: 'mail_test_limited' });
    }
    testSends.set(who, [...recent, now]);
    // Only to the editor's own address (from the DB, never the request), only sample values, marked as a test.
    const r = await mail.sendMail(k.kind, to, sampleValues(k), { override: { subject: `[בדיקה] ${subject}`, body } });
    void writeAudit(actorOf(req), 'mail.test_sent', k.kind, { status: r.status });
    res.json({ data: { status: r.status, to: 'self' } });
  } catch (e) { next(e); }
};

export const removeSuppression = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ message: 'A valid email is required', code: 'bad_request' });
    const removed = await mail.unsuppress(email);
    // A hash of the address only (the log never holds the address itself).
    void writeAudit(actorOf(req), 'mail.suppression_removed', `email:${emailKey(email).slice(0, 16)}`, { removed });
    res.json({ data: { removed } });
  } catch (e) { next(e); }
};

/** POST /api/webhooks/resend — raw body (index.ts). Signed by Resend; anything unsigned or stale → 401, nothing done. */
export const resendWebhook = async (req: Request, res: Response) => {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const check = verifySvix(process.env.RESEND_WEBHOOK_SECRET, {
    id: req.header('svix-id'), timestamp: req.header('svix-timestamp'), signature: req.header('svix-signature'),
  }, raw);
  if (!check.ok) {
    if (check.reason === 'no_secret') return res.status(503).json({ message: 'Webhook not configured', code: 'mail_webhook_off' });
    console.warn(`[mail] webhook refused: ${check.reason}`);
    return res.status(401).json({ message: 'Invalid signature', code: 'mail_webhook_signature' });
  }
  try {
    if (!(await mail.firstDelivery(String(req.header('svix-id'))))) return res.json({ data: { duplicate: true } });
    let event: unknown;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ message: 'Bad JSON', code: 'bad_request' }); }
    const o = interpretEvent(event);
    if (o.emailId && o.status) await mail.updateSendStatus(o.emailId, o.status);
    if (o.suppress) {
      for (const to of o.recipients) {
        await mail.suppress(to, o.suppress);
        void writeAudit('system:resend', 'mail.suppressed', `email:${emailKey(to).slice(0, 16)}`, { reason: o.suppress, email_id: o.emailId });
        // A spam complaint also removes the address from marketing mail (docs/marketing-consent.md).
        if (o.suppress === 'complaint') await removeByComplaint(to, o.emailId);
      }
    }
    console.info(`[mail] webhook ${String((event as any)?.type ?? '-').slice(0, 40)} email_id=${o.emailId ?? '-'}`);
    res.json({ data: { ok: true } });
  } catch (e) {
    console.error('[mail] webhook failed', safeErrorText(e));
    res.status(500).json({ message: 'Webhook failed', code: 'mail_webhook_failed' });
  }
};
