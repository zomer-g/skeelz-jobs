/**
 * Threshold condition (תנאי סף) — pure rules (no DB). Unit tests: test/unit/thresholdCondition.test.ts.
 * Rules for people: docs/jobs-management.md ("Threshold condition").
 *
 * A job may carry one short plain-text condition ("at least 2 years in sales", "a lawyer's licence"). Before an
 * application to such a job is accepted, the candidate confirms in a pop-up that they meet it. The SERVER enforces
 * it: every way to apply through SKEELZ (regular application, any CV choice, quick/guest application) is refused
 * with 400 threshold_not_confirmed unless the request carries `thresholdConfirmed: true`. What is stored about the
 * candidate: only that they confirmed and when (job_applications / guest_applications.threshold_confirmed[_at]).
 *
 * The text is plain text: tags, control characters and bidi overrides are removed, newlines kept (at most one
 * blank line), trimmed, capped at THRESHOLD_CONDITION_LIMITS.max. Empty → null (no condition). It is always shown
 * as text, never as HTML. Jobs imported from the existing site are read-only, so they never have one.
 */

export const THRESHOLD_CONDITION_LIMITS = { min: 3, max: 500 } as const;

/** The request field that carries the candidate's confirmation. Only the boolean true counts. */
export const THRESHOLD_CONFIRM_FIELD = 'thresholdConfirmed';

// Control characters (except tab/newline) and bidi overrides/isolates that could disguise the text.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
// Anything that looks like a tag or an HTML comment ("<b>", "</p>", "<!-- -->", "<img ...>").
const TAG_RE = /<\/?[A-Za-z!][^<>]*>/g;

/** Plain text, cleaned (see the header). Non-strings and empty text → ''. Not capped (the caller checks length). */
export const cleanThresholdText = (v: unknown): string => {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r\n?/g, '\n')
    .replace(TAG_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export type ThresholdCheck = { ok: true; value: string | null } | { ok: false; error: 'too_short' | 'too_long' | 'invalid' };

/**
 * Validates a condition sent by staff or an employer. undefined is the caller's "not sent"; null / '' / only
 * spaces or tags → no condition (null). Too short or too long (after cleaning) → refused.
 */
export const checkThresholdCondition = (v: unknown): ThresholdCheck => {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, error: 'invalid' };
  const s = cleanThresholdText(v);
  if (!s) return { ok: true, value: null };
  if (s.length < THRESHOLD_CONDITION_LIMITS.min) return { ok: false, error: 'too_short' };
  if (s.length > THRESHOLD_CONDITION_LIMITS.max) return { ok: false, error: 'too_long' };
  return { ok: true, value: s };
};

/** A stored value as it goes out (always text or null; a stray long value is capped, never trusted as HTML). */
export const thresholdConditionOf = (stored: unknown): string | null => {
  const s = cleanThresholdText(stored);
  return s ? s.slice(0, THRESHOLD_CONDITION_LIMITS.max) : null;
};

/** Did the request confirm? Only `thresholdConfirmed: true` (a boolean) counts — not "true", 1 or "on". */
export const isThresholdConfirmed = (body: unknown): boolean =>
  !!body && typeof body === 'object' && (body as Record<string, unknown>)[THRESHOLD_CONFIRM_FIELD] === true;

/**
 * Is an application to a job with this condition refused? null = accepted (no condition, or confirmed);
 * 'threshold_not_confirmed' = the job has a condition and the request did not confirm it.
 */
export const thresholdRefusal = (condition: unknown, confirmed: boolean): null | 'threshold_not_confirmed' =>
  thresholdConditionOf(condition) && !confirmed ? 'threshold_not_confirmed' : null;

/** What is stored with an accepted application: confirmed only when the job had a condition. */
export const thresholdRecord = (condition: unknown, confirmed: boolean, now: Date = new Date()): { confirmed: boolean; at: Date | null } =>
  thresholdConditionOf(condition) && confirmed ? { confirmed: true, at: now } : { confirmed: false, at: null };
