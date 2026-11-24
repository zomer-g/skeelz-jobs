// "Apply → sign in → straight back to applying" (owner, 24.11.2026).
//
// A visitor who presses "הגש מועמדות" on a job that takes no quick (guest) application signs in first. The job is
// remembered here (this tab's sessionStorage: the job id and the time, nothing personal) so that after ANY way of
// signing in — a code by email, Google, Microsoft (full-page redirects), the sign-up form of a new person, the
// "complete your details" form — the person lands on that job's apply step without pressing again.
//
// Safety: only a job id of the site's own shape is kept, and the only place it ever leads is the same-site path
// `/job/<id>` (the server's safeReturnPath checks the return_to again). It expires after INTENT_TTL_MS and is used once.
//
//   saveApplyIntent(jobId)   on the apply click of a signed-out visitor
//   resumeApplyIntent()      when the sign-in (and any form after it) is done: the job's apply buttons take it
//   takeReadyIntent(jobId)   ApplyJobButtons: true once, when the intent for this job is ready
//   clearApplyIntent()       the visitor gave up (closed the sign-in window) or signed up as an employer

import { modalStore } from '../store/Modal.store';

const KEY = 'skeelz:apply-intent';
const EVENT = 'skeelz:apply-intent-ready';
const INTENT_TTL_MS = 30 * 60 * 1000;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Intent = { jobId: string; at: number; ready: boolean };

const read = (): Intent | null => {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.jobId !== 'string' || !JOB_ID.test(v.jobId) || typeof v.at !== 'number') return null;
    if (Date.now() - v.at > INTENT_TTL_MS || v.at > Date.now() + 60_000) { clearApplyIntent(); return null; }
    return { jobId: v.jobId, at: v.at, ready: v.ready === true };
  } catch { return null; }
};
const write = (i: Intent) => { try { window.sessionStorage.setItem(KEY, JSON.stringify(i)); } catch { /* private mode */ } };

export const clearApplyIntent = () => { try { window.sessionStorage.removeItem(KEY); } catch { /* private mode */ } };

/** The same-site path of a job page, or null for anything that isn't a job id. */
export const jobPath = (jobId: string): string | null => (JOB_ID.test(jobId) ? `/job/${jobId}` : null);

export const saveApplyIntent = (jobId: string | undefined | null) => {
  if (!jobId || !JOB_ID.test(String(jobId))) return;
  write({ jobId: String(jobId), at: Date.now(), ready: false });
};

/** Where "Continue with Google / Microsoft" should come back to: the job being applied to, if any. */
export const applyIntentReturnPath = (): string | null => {
  const i = read();
  return i ? jobPath(i.jobId) : null;
};

/** Is an application waiting for this sign-in? (used to word the sign-in window) */
export const hasApplyIntent = (): boolean => read() !== null;

// The job buttons that are on screen now (a job modal is open), so a resume reaches them without a reload.
const mounted = new Set<string>();
export const registerApplyButtons = (jobId: string) => { mounted.add(jobId); return () => { mounted.delete(jobId); }; };
export const onApplyIntentReady = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/**
 * Sign-in done: go on with the application. The job's apply buttons start it (takeReadyIntent).
 *  - the job is on screen → they hear the event;
 *  - the job modal kept aside when the sign-in window opened (the modal store's pending modal) is brought back →
 *    they start when they mount;
 *  - otherwise the job page is opened (same-site path only).
 * Returns false when nothing was waiting.
 */
export const resumeApplyIntent = (): boolean => {
  const i = read();
  if (!i) return false;
  write({ ...i, ready: true });
  if (mounted.has(i.jobId)) { window.dispatchEvent(new Event(EVENT)); return true; }
  const modals = modalStore.getState();
  if (modals.pendingModal) { modals.openPendingModalIfExists(); return true; }
  const path = jobPath(i.jobId);
  if (path) window.location.assign(path);
  return true;
};

/** For ApplyJobButtons: true (once) when an intent for this job is ready; it is used up. */
export const takeReadyIntent = (jobId: string): boolean => {
  const i = read();
  if (!i || !i.ready || i.jobId !== jobId) return false;
  clearApplyIntent();
  return true;
};
