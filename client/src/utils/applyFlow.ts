// The apply funnel as one tracked "flow" per application attempt (docs/analytics.md §3, "Apply funnel").
//
// Pure (no DOM, no React) so server/test/analytics.test.ts can drive it. analytics.ts creates the single instance
// with track() as `emit` and calls abandon('page_left') when the page is left.
//
// Every event the flow emits carries the same keys — job_id, apply_type, apply_mode, cv_required, has_threshold,
// cv_choice (once chosen), step (number), step_name — so a GA4 funnel exploration can be built on step_name or on
// the event names, and broken down by mode / CV rule / threshold. Only ids, enums and booleans: never a name, a file
// name or the condition's text.
import { ApplyMode, ApplyStepName, applyStepNumber, CvChoice, EventName, EventParams } from './analyticsPolicy';

export type FlowApplyType = 'guest' | 'registered' | 'self_apply';
export interface FlowStart {
  job_id: string;
  apply_type: FlowApplyType;
  apply_mode?: ApplyMode;
  /** The job's CV rule for this way of applying ('required' → true). */
  cv_required?: boolean;
  /** The job has a threshold condition (the dialog will ask to confirm it). */
  has_threshold?: boolean;
}
interface Flow extends FlowStart { cv_choice?: CvChoice; furthest: ApplyStepName; done: boolean }
export type Emit = (name: EventName, params: EventParams) => void;
export type AbandonReason = 'dialog_closed' | 'page_left' | 'other_job';

export function createApplyFlow(emit: Emit) {
  let flow: Flow | null = null;

  const paramsAt = (f: Flow, step: ApplyStepName): EventParams => ({
    job_id: f.job_id,
    apply_type: f.apply_type,
    apply_mode: f.apply_mode,
    cv_required: f.cv_required,
    has_threshold: !!f.has_threshold,
    cv_choice: f.cv_choice,
    step: applyStepNumber(step),
    step_name: step,
  });
  const isOpen = (jobId?: string) => !!flow && !flow.done && (!jobId || flow.job_id === jobId);

  const api = {
    /** The visitor began applying. Same job again while open: no new start (fills in what was unknown). */
    start(s: FlowStart): boolean {
      if (flow && !flow.done) {
        if (flow.job_id === s.job_id) {
          for (const k of ['apply_mode', 'cv_required', 'has_threshold'] as const) {
            if (flow[k] === undefined && s[k] !== undefined) (flow as any)[k] = s[k];
          }
          return false;
        }
        api.abandon('other_job');
      }
      flow = { ...s, furthest: 'start', done: false };
      emit('apply_start', paramsAt(flow, 'start'));
      return true;
    },
    /** Start a flow if none is open for this job (a path that applies without a button we know of). */
    ensure(s: FlowStart) {
      api.start(s); // a no-op for an open flow of the same job, apart from filling in unknown fields
    },
    /** One funnel step. Ignored when no flow is open for this job. */
    step(name: EventName, step: ApplyStepName, extra: EventParams = {}, jobId?: string) {
      if (!isOpen(jobId)) return;
      const f = flow!;
      if (applyStepNumber(step) > applyStepNumber(f.furthest)) f.furthest = step;
      emit(name, { ...paramsAt(f, step), ...extra });
    },
    /** What became known on the way (the CV choice; the threshold condition, read again before sending). */
    set(patch: { cv_choice?: CvChoice; has_threshold?: boolean }, jobId?: string) {
      if (!isOpen(jobId)) return;
      Object.assign(flow!, patch);
    },
    /** The server accepted the application: the flow is complete. */
    succeed(jobId?: string) {
      if (!isOpen(jobId)) return;
      api.step('apply_success', 'success', {}, jobId);
      flow!.done = true;
    },
    /** The server (or the client, before sending) refused it. The flow stays open: they may fix it and retry. */
    fail(code: string, jobId?: string) {
      if (!isOpen(jobId)) return;
      emit('apply_error', { ...paramsAt(flow!, 'submit'), error_code: code });
    },
    /** Left without applying: the dialog/job was closed, the page was left, or another job was started.
     *  `onlyMode`: only an attempt of that kind (the job window closing ends a guest's attempt, not the CV
     *  dialog that replaced it for a signed-in candidate). */
    abandon(reason: AbandonReason, jobId?: string, onlyMode?: ApplyMode) {
      if (!isOpen(jobId)) return;
      const f = flow!;
      if (onlyMode && f.apply_mode !== onlyMode) return;
      f.done = true;
      emit('apply_abandon', { ...paramsAt(f, f.furthest), abandon_reason: reason });
    },
    isOpen,
    /** For tests. */
    current: () => (flow ? { ...flow } : null),
  };
  return api;
}

export type ApplyFlow = ReturnType<typeof createApplyFlow>;
