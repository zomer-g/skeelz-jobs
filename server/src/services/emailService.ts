/* ============================================================================
 *  Outgoing email: Resend (https://resend.com), owner-approved 2026-11.
 *
 *  Sends only when SEND_EMAIL_ENABLED=true AND RESEND_API_KEY (secret) and EMAIL_FROM (plain env, e.g.
 *  `SKEELZ <no-reply@mail.example>`) are set. Otherwise the message is only logged: in development with its
 *  text (so a developer can read a sign-in code), in production the subject only.
 *
 *  Never logged, whatever happens: the address, the text, a code, Resend's response body. Logged: the outcome,
 *  the HTTP status, Resend's message id and our error code. Who receives what is in the privacy texts
 *  (client/src/components/privacy) — keep them true when adding a new kind of email.
 * ========================================================================== */
import { EmailErrorCodes } from '../i18n/i18n.js';

export const RESEND_URL = 'https://api.resend.com/emails';
export const EMAIL_TIMEOUT_MS = 10_000;

export class EmailSendError extends Error {
  /** em1 (generic) / em2 (not configured) / em3 (timeout or network) / em4 (refused by Resend). */
  constructor(public code: string, public status?: number) {
    super(`email not sent (${code}${status ? `, HTTP ${status}` : ''})`);
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML; when absent an RTL HTML version is built from the text. */
  html?: string;
  /** A tag for Resend's dashboard (ASCII letters, digits, _ and - only), e.g. `sign_in_code`. Never personal data. */
  kind?: string;
  /** Resend's Idempotency-Key (a retry of the same request does not send twice). Never personal data. */
  idempotencyKey?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Right-to-left HTML around plain text (paragraphs on blank lines, line breaks kept). */
export const rtlHtml = (text: string, isRtl = true): string => {
  const dir = isRtl ? 'rtl' : 'ltr';
  const align = isRtl ? 'right' : 'left';
  const body = text.trim().split(/\n\s*\n/).map((p) =>
    `<p style="margin:0 0 14px">${p.split('\n').map((l) => escapeHtml(l.trim())).join('<br>')}</p>`).join('');
  return `<!doctype html><html lang="${isRtl ? 'he' : 'en'}" dir="${dir}"><head><meta charset="utf-8"></head>`
    + `<body dir="${dir}" style="margin:0;padding:24px;background:#f6f6f6">`
    + `<div dir="${dir}" style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;`
    + `font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222;text-align:${align}">${body}</div></body></html>`;
};

export const emailConfig = (env: Record<string, string | undefined> = process.env) => {
  const apiKey = env.RESEND_API_KEY || '';
  const from = (env.EMAIL_FROM || '').trim();
  const enabled = env.SEND_EMAIL_ENABLED === 'true';
  return { enabled, configured: !!apiKey && !!from, apiKey, from, ready: enabled && !!apiKey && !!from };
};

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests only: replace fetch. */
export const _setFetchForTests = (f: Fetch | null) => { fetchImpl = f ?? ((...a) => fetch(...a)); };

/** Sends one email, or throws EmailSendError. Logs ids and status only. */
export const deliver = async (m: EmailMessage, isRtl = true): Promise<{ sent: boolean; id?: string }> => {
  const cfg = emailConfig();
  if (!cfg.ready) {
    if (cfg.enabled && !cfg.configured) {
      console.error(`[email] not sent (${EmailErrorCodes.NOT_CONFIGURED}): SEND_EMAIL_ENABLED=true but RESEND_API_KEY or EMAIL_FROM is missing`);
      throw new EmailSendError(EmailErrorCodes.NOT_CONFIGURED);
    }
    // Never the subject or text, not even in development: they can hold a sign-in code, a name or an address
    // (CLAUDE.md: no personal data in console output). The e2e suites read codes through /api/dev/email-code.
    console.info('[email not sent: SEND_EMAIL_ENABLED is not true] kind=%s', m.kind ?? '-');
    return { sent: false };
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
  if (m.idempotencyKey) headers['Idempotency-Key'] = m.idempotencyKey.slice(0, 256);
  const body: Record<string, unknown> = {
    from: cfg.from, to: [m.to], subject: m.subject, text: m.text, html: m.html ?? rtlHtml(m.text, isRtl),
  };
  if (m.kind && /^[A-Za-z0-9_-]{1,64}$/.test(m.kind)) body.tags = [{ name: 'kind', value: m.kind }];
  let res: Response;
  try {
    res = await fetchImpl(RESEND_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS) });
  } catch (e) {
    const timeout = (e as any)?.name === 'TimeoutError' || (e as any)?.name === 'AbortError';
    console.error(`[email] not sent (${EmailErrorCodes.NETWORK}): ${timeout ? 'timeout' : 'network error'} kind=${m.kind ?? '-'}`);
    throw new EmailSendError(EmailErrorCodes.NETWORK);
  }
  // The body is read only for the id; an error body (it can echo the address) is never printed.
  let id: string | undefined;
  try { const j: any = await res.json(); id = typeof j?.id === 'string' ? j.id.slice(0, 64) : undefined; } catch { /* no body */ }
  if (!res.ok) {
    console.error(`[email] not sent (${EmailErrorCodes.REFUSED}): HTTP ${res.status} kind=${m.kind ?? '-'}`);
    throw new EmailSendError(EmailErrorCodes.REFUSED, res.status);
  }
  console.info(`[email] sent id=${id ?? '-'} kind=${m.kind ?? '-'}`);
  return { sent: true, id };
};

/**
 * The old signature, for the existing notices (welcome, staff invite, new-application notices to the team). A failure
 * is logged (code only) and swallowed, as before: a notice never breaks the action that triggered it.
 */
export const sendEmail = async (to: string, subject: string, text: string, isRtl: boolean = true, kind = 'notice'): Promise<void> => {
  if (!to) return;
  try {
    await deliver({ to, subject, text, kind }, isRtl);
  } catch (e) {
    if (!(e instanceof EmailSendError)) console.error(`[email] not sent (${EmailErrorCodes.EMAIL_FAILED}) kind=${kind}`);
  }
};
