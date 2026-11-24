// The apply funnel (client/src/utils/applyFlow.ts + the allowlist in analyticsPolicy.ts): every step of every way
// of applying is recorded with the same keys, abandonment carries the furthest step, and nothing personal (names,
// file names, the threshold condition's text) can ride along. See docs/analytics.md "Apply funnel".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvent, EVENTS, APPLY_STEPS, applyStepNumber, applyErrorFromApiCode } from '../../client/src/utils/analyticsPolicy.ts';
import { createApplyFlow } from '../../client/src/utils/applyFlow.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const JOB = '0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba98';

const recorder = () => {
  const events: Record<string, any>[] = [];
  const flow = createApplyFlow((name, params) => {
    const built = buildEvent(name, params);
    assert.ok(built, `${name} is not on the allowlist`);
    // Nothing the flow sends may be dropped by the allowlist (every flow key is allowed on every step event).
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) assert.equal(built![k], v, `${name}.${k} was dropped`);
    }
    events.push(built!);
  });
  return { flow, events, names: () => events.map((e) => e.event) };
};

test('apply funnel: a signed-in application with a required CV and a threshold condition, step by step', () => {
  const { flow, events, names } = recorder();
  flow.start({ job_id: JOB, apply_type: 'registered', apply_mode: 'regular', cv_required: true, has_threshold: true });
  flow.step('apply_cv_step', 'cv_step', {}, JOB);
  flow.step('apply_cv_upload_start', 'cv_upload', {}, JOB);
  flow.step('apply_cv_upload', 'cv_upload', { file_type: 'pdf', file_size_kb: 120 }, JOB);
  flow.set({ cv_choice: 'job_only' }, JOB);
  flow.step('apply_cv_choice', 'cv_choice', {}, JOB);
  flow.step('apply_threshold_shown', 'threshold', {}, JOB);
  flow.step('apply_threshold_confirmed', 'threshold_confirmed', {}, JOB);
  flow.step('apply_submit', 'submit', {}, JOB);
  flow.succeed(JOB);
  assert.deepEqual(names(), ['apply_start', 'apply_cv_step', 'apply_cv_upload_start', 'apply_cv_upload', 'apply_cv_choice',
    'apply_threshold_shown', 'apply_threshold_confirmed', 'apply_submit', 'apply_success']);
  // The same keys on every step: a funnel can be broken down by mode, CV rule and threshold.
  for (const e of events) {
    assert.equal(e.job_id, JOB);
    assert.equal(e.apply_mode, 'regular');
    assert.equal(e.cv_required, true);
    assert.equal(e.has_threshold, true);
    assert.ok((APPLY_STEPS as readonly string[]).includes(e.step_name));
    assert.equal(e.step, applyStepNumber(e.step_name));
  }
  assert.equal(events.at(-1)!.cv_choice, 'job_only');
  const steps = events.map((e) => e.step);
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, 'step numbers follow the order of the funnel');
  // After success nothing more is recorded for this attempt.
  flow.abandon('page_left');
  assert.equal(names().at(-1), 'apply_success');
});

test('apply funnel: abandonment carries the furthest step reached and why', () => {
  // Required CV, closed at the CV step: "how many left when they had to upload a CV".
  let r = recorder();
  r.flow.start({ job_id: JOB, apply_type: 'registered', apply_mode: 'regular', cv_required: true });
  r.flow.step('apply_cv_step', 'cv_step', {}, JOB);
  r.flow.abandon('dialog_closed', JOB, 'regular');
  let last = r.events.at(-1)!;
  assert.equal(last.event, 'apply_abandon');
  assert.equal(last.step_name, 'cv_step');
  assert.equal(last.step, applyStepNumber('cv_step'));
  assert.equal(last.abandon_reason, 'dialog_closed');
  assert.equal(last.cv_required, true);

  // Threshold dialog closed without confirming, then the page left: abandoned at the threshold step.
  r = recorder();
  r.flow.start({ job_id: JOB, apply_type: 'guest', apply_mode: 'quick', cv_required: false, has_threshold: true });
  r.flow.step('apply_threshold_shown', 'threshold', {}, JOB);
  r.flow.step('apply_threshold_dismissed', 'threshold', {}, JOB);
  r.flow.abandon('page_left');
  last = r.events.at(-1)!;
  assert.deepEqual([last.event, last.step_name, last.abandon_reason, last.has_threshold], ['apply_abandon', 'threshold', 'page_left', true]);

  // A refusal keeps the attempt open (they can fix it and retry); the error carries the code only.
  r = recorder();
  r.flow.start({ job_id: JOB, apply_type: 'registered', apply_mode: 'regular' });
  r.flow.step('apply_submit', 'submit', {}, JOB);
  r.flow.fail('threshold_not_confirmed', JOB);
  assert.equal(r.events.at(-1)!.event, 'apply_error');
  assert.equal(r.events.at(-1)!.error_code, 'threshold_not_confirmed');
  assert.ok(r.flow.isOpen(JOB));
});

test('apply funnel: one attempt at a time; closing the job window ends only a guest attempt', () => {
  const { flow, events } = recorder();
  flow.start({ job_id: JOB, apply_type: 'registered', apply_mode: 'regular' });
  // The job window closes because the CV dialog replaced it: not an abandonment of a regular attempt.
  flow.abandon('dialog_closed', JOB, 'quick');
  assert.ok(flow.isOpen(JOB));
  // The same job again does not restart it, but fills in what was unknown.
  assert.equal(flow.start({ job_id: JOB, apply_type: 'registered', apply_mode: 'regular', cv_required: true }), false);
  assert.equal(flow.current()!.cv_required, true);
  // Another job: the first attempt is abandoned ("other_job"), a new one starts.
  flow.start({ job_id: OTHER, apply_type: 'guest', apply_mode: 'quick' });
  assert.deepEqual(events.slice(-2).map((e) => [e.event, e.job_id, e.abandon_reason]),
    [['apply_abandon', JOB, 'other_job'], ['apply_start', OTHER, undefined]]);
  // Steps for a job without an open attempt are ignored.
  const n = events.length;
  flow.step('apply_submit', 'submit', {}, JOB);
  assert.equal(events.length, n);
});

test('apply funnel: nothing personal can ride along (condition text, file names, emails, free text)', () => {
  for (const name of Object.keys(EVENTS).filter((n) => n.startsWith('apply_'))) {
    const ev = buildEvent(name, {
      job_id: JOB, threshold_text: 'מינימום 3 שנות ניסיון', cv_file_name: 'Dana_Cohen_CV.pdf', email: 'dana@example.com',
      step_name: 'דנה כהן', abandon_reason: 'מחפשת עבודה', error_code: 'dana@example.com', apply_mode: 'vip',
    } as any)!;
    for (const k of ['threshold_text', 'cv_file_name', 'email', 'step_name', 'abandon_reason', 'error_code', 'apply_mode']) {
      assert.equal(ev[k], undefined, `${name}.${k} accepted something it must not`);
    }
  }
  assert.equal(buildEvent('apply_cv_choice', { cv_choice: 'keep' })!.cv_choice, undefined, 'old values are gone');
  assert.equal(buildEvent('apply_cv_choice', { cv_choice: 'updated' })!.cv_choice, 'updated');
});

test('apply funnel: server error codes become readable codes, never message text', () => {
  assert.equal(applyErrorFromApiCode('jb11'), 'cv_required');
  assert.equal(applyErrorFromApiCode('threshold_not_confirmed'), 'threshold_not_confirmed');
  assert.equal(applyErrorFromApiCode('limit_people'), 'limit_reached');
  assert.equal(applyErrorFromApiCode('jb7'), 'jb7');
  assert.equal(applyErrorFromApiCode('Some message text'), null);
  assert.equal(applyErrorFromApiCode(null), null);
  for (const c of ['cv_required', 'threshold_not_confirmed', 'limit_reached', 'jb7', 'consent_needed', 'employer_account']) {
    assert.equal(buildEvent('apply_error', { error_code: c })!.error_code, c, c);
  }
});

test('the client: every apply path goes through the funnel; submit / success / error only in JobService', () => {
  const svc = read('client', 'src', 'services', 'api', 'Job.service.ts');
  for (const must of ["'apply_threshold_shown'", "'apply_threshold_confirmed'", "'apply_threshold_dismissed'",
    "'apply_terms_shown'", "'apply_terms_declined'", "'apply_submit'", 'applyFlow.succeed', 'applyFlow.fail']) {
    assert.ok(svc.includes(must), `Job.service.ts misses ${must}`);
  }
  for (const f of ['ApplyWithCvDialog.tsx', 'ExtendedJobCard.tsx', 'JobCard.tsx']) {
    assert.doesNotMatch(read('client', 'src', 'components', 'jobcard', f), /['"]apply_(submit|success|error)['"]/, f);
  }
  assert.match(read('client', 'src', 'components', 'jobcard', 'ApplyWithCvDialog.tsx'), /applyFlow\.abandon\("dialog_closed", jobId, "regular"\)/);
  assert.match(read('client', 'src', 'components', 'jobcard', 'ExtendedJobCard.tsx'), /applyFlow\.abandon\('dialog_closed', jobKey, 'quick'\)/);
  assert.match(read('client', 'src', 'utils', 'analytics.ts'), /addEventListener\('pagehide', \(\) => applyFlow\.abandon\('page_left'\)\)/);
});
