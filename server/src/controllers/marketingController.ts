/* ============================================================================
 *  Marketing consent and removals (security/marketing.ts, docs/marketing-consent.md).
 *
 *    GET  /admin/users/:id/marketing            staff viewers: one candidate's state and history (peopleHandover)
 *    POST /admin/users/:id/marketing-optout     content managers: remove a candidate on their request
 *    POST /admin/marketing/optouts              content managers: remove an address (with or without an account)
 *    POST /unsubscribe                          public: the one-click link of a marketing email (signed token)
 *
 *  Nobody but the person can say "yes" (personal area, a form they fill while signed in): there is no staff route for
 *  it. Logged with ids / keyed hashes only: marketing.removed_by_staff, marketing.unsubscribed, marketing.complaint
 *  (and user.marketing_consent_changed for the personal area).
 * ========================================================================== */
import { NextFunction, Request, Response } from 'express';
import { queryOne } from '../config/db.js';
import * as marketingDAL from '../dal/marketingDAL.js';
import { actorOf, writeAudit, writeAuditStrict } from '../security/audit.js';
import { emailKey, isValidEmail, normalizeEmail } from '../security/emailCode.js';
import { peopleHandover } from '../security/handover.js';
import { verifyUnsubscribeToken } from '../security/marketing.js';
import { isObjectId } from '../utils/ids.js';

const keyRef = (key: string) => `email:${key.slice(0, 16)}`;

export const candidateMarketing = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '');
    if (!isObjectId(id)) return res.status(404).json({ message: 'Not found', code: 'not_found' });
    // One candidate's data: counted and logged (strict, before it leaves) like any candidate shown to staff.
    const { rows } = await peopleHandover({
      who: actorOf(req), action: 'candidates.shown', place: 'GET /api/admin/users/:id/marketing', details: { view: 'marketing' },
      load: async () => { const v = await marketingDAL.marketingOf(id); return v ? [{ id, v }] : []; },
      idOf: (r) => r.id,
    });
    if (!rows.length) return res.status(404).json({ message: 'Not found', code: 'not_found' });
    res.json({ data: rows[0].v });
  } catch (e) { next(e); }
};

export const removeCandidate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id ?? '');
    if (!isObjectId(id)) return res.status(404).json({ message: 'Not found', code: 'not_found' });
    const view = await marketingDAL.marketingOf(id);
    if (!view) return res.status(404).json({ message: 'Not found', code: 'not_found' });
    const by = actorOf(req);
    const row = await queryOne<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id]);
    await marketingDAL.recordRemoval({ key: emailKey(row!.email), userId: id }, 'staff', by);
    await writeAuditStrict(by, 'marketing.removed_by_staff', `user:${id}`, { before: view.status });
    res.json({ data: { status: 'removed' } });
  } catch (e) { next(e); }
};

/** An address someone asked (by email, phone…) to remove. Answers the same whether or not it has an account. */
export const removeAddress = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ message: 'A valid email is required', code: 'bad_request' });
    const by = actorOf(req);
    const key = emailKey(email);
    const userId = await marketingDAL.candidateIdByEmail(email);
    await marketingDAL.recordRemoval({ key, userId }, 'staff', by);
    await writeAuditStrict(by, 'marketing.removed_by_staff', userId ? `user:${userId}` : keyRef(key), { by_address: true });
    res.json({ data: { status: 'removed' } });
  } catch (e) { next(e); }
};

/**
 * POST /api/unsubscribe?t=… (or { t }): RFC 8058 one-click (a mail client POSTs "List-Unsubscribe=One-Click") and the
 * button on the /unsubscribe page. No sign-in; the same answer for every valid token, whether or not the address has
 * an account or was already removed. A bad token: 400, nothing done.
 */
export const unsubscribe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = (typeof req.query.t === 'string' ? req.query.t : undefined) ?? (typeof req.body?.t === 'string' ? req.body.t : undefined);
    const p = verifyUnsubscribeToken(token);
    if (!p) return res.status(400).json({ message: 'This link is not valid', code: 'unsubscribe_invalid' });
    // The account only if its address still gives the same key (the address may have changed since).
    const userId = p.u && (await marketingDAL.userHasKey(p.u, p.k)) ? p.u : null;
    await marketingDAL.recordRemoval({ key: p.k, userId }, 'link', 'link:unsubscribe');
    void writeAudit(`anonymous:${req.ip ?? ''}`, 'marketing.unsubscribed', userId ? `user:${userId}` : keyRef(p.k), null);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: { status: 'removed' } });
  } catch (e) { next(e); }
};

/** A spam complaint about any email (Resend webhook): the address is also removed from marketing. */
export const removeByComplaint = async (address: string, emailId: string | null) => {
  const key = emailKey(address);
  const userId = await marketingDAL.candidateIdByEmail(address);
  await marketingDAL.recordRemoval({ key, userId }, 'complaint', 'system:resend');
  void writeAudit('system:resend', 'marketing.complaint', userId ? `user:${userId}` : keyRef(key), { email_id: emailId });
};
