// Consent on the forms that collect personal data (sign-up, SSO sign-up, guest apply, registered apply, employer
// job form). Pure: no DB, no Express — unit-tested in test/unit/consent.test.ts.
//
// Two separate boxes, sent as two fields:
// - `consent` — REQUIRED: the terms of use and the privacy policy (/privacy), including the transfer of data to
//   employers about the jobs applied to, to service providers, and to third parties under agreements with the
//   nonprofit. Only the literal `true` counts.
// - `marketingConsent` — OPTIONAL, unticked by default: marketing mail and updates about cooperations. Kept
//   separate because marketing consent must be explicit and freely given (Communications Law, s. 30A). Set
//   MARKETING_REQUIRED to true to make it a condition (the owner's call — see docs/security.md).
//
// When the wording of the terms changes in a way that needs a new agreement, bump TERMS_VERSION: registered
// candidates are asked again on their next application.

// Every version is kept as published (server/privacy-versions/<TERMS_VERSION>.html → privacy_versions) and every
// acceptance is recorded in consent_records (time, who, version). Bumping it: change the texts, then
// `cd client && npm run snapshot:privacy` — server/test/privacy.test.ts fails while the page and the file differ.
export const TERMS_VERSION = '2026-11-23-b';
export const MARKETING_REQUIRED = false;

export type ConsentError = 'terms_required' | 'marketing_required' | 'marketing_invalid';

export interface ConsentAnswer {
  /** true when the required box was ticked in this request. */
  terms: boolean;
  /** true / false when answered in this request; null when not asked / not sent. */
  marketing: boolean | null;
}

export interface ConsentCheck { ok: boolean; error?: ConsentError; value: ConsentAnswer }

/**
 * Validates the two fields of a request body.
 * `needTerms`: the required box must be ticked (false for a registered candidate who already accepted the current
 * version). `askMarketing`: the marketing question is part of this form (absent = "no" unless MARKETING_REQUIRED).
 */
export function checkConsent(body: unknown, opts: { needTerms: boolean; askMarketing: boolean }): ConsentCheck {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const terms = b.consent === true;
  const raw = b.marketingConsent;
  let marketing: boolean | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'boolean') return { ok: false, error: 'marketing_invalid', value: { terms, marketing: null } };
    marketing = raw;
  }
  if (opts.askMarketing && marketing === null && !MARKETING_REQUIRED) marketing = false;
  const value = { terms, marketing: opts.askMarketing || marketing !== null ? marketing : null };
  if (opts.needTerms && !terms) return { ok: false, error: 'terms_required', value };
  if (opts.askMarketing && MARKETING_REQUIRED && marketing !== true) return { ok: false, error: 'marketing_required', value };
  return { ok: true, value };
}

/** What a registered candidate still has to answer before applying. */
export interface ConsentState { termsVersion: string | null; marketingConsent: boolean | null }
export const needsTerms = (s: ConsentState): boolean => s.termsVersion !== TERMS_VERSION;
export const needsMarketingAnswer = (s: ConsentState): boolean => s.marketingConsent === null || s.marketingConsent === undefined;

/**
 * A registered candidate applying: the terms box is needed only if they never accepted the current version, the
 * marketing box only if they never answered it. `missing` → answer 428 consent_needed with what to show; else
 * `record` is what to store (nothing when both were answered before).
 */
export function applyConsent(state: ConsentState, body: unknown): {
  needTerms: boolean; needMarketing: boolean; missing: boolean; record: { terms?: true; marketing?: boolean };
} {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const needTerms = needsTerms(state);
  const needMarketing = needsMarketingAnswer(state);
  const termsOk = !needTerms || b.consent === true;
  const m = b.marketingConsent;
  const marketingOk = !needMarketing || (typeof m === 'boolean' && (!MARKETING_REQUIRED || m));
  const record: { terms?: true; marketing?: boolean } = {};
  if (needTerms && termsOk) record.terms = true;
  if (needMarketing && marketingOk) record.marketing = m as boolean;
  return { needTerms, needMarketing, missing: !termsOk || !marketingOk, record };
}

/** The only gate for the mailing list: nobody without an explicit "yes" is ever pushed. */
export const mayAddToMailingList = (marketingConsent: boolean | null | undefined): boolean => marketingConsent === true;
