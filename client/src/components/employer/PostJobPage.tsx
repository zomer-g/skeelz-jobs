// Public page /post-job: an employer sends a job without an account.
// Server: POST /api/job-submissions (server/src/controllers/jobSubmissionController.ts).
// The job is stored as pending and shown nowhere until staff approve it.
import React, { useEffect, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import useLanguageStore from '../../store/Language.store';
import { track, trackOnce } from '../../utils/analytics';
import { postJobStepOf } from '../../utils/analyticsPolicy';
import SubmissionFields, { EMPTY_VALUES, ErrorSummary, Errors, FIELD_ORDER, SubmissionValues, fieldId, validate } from './SubmissionFields';

const PREFIX = 'post-job';

const PostJobPage: React.FC = () => {
  useLanguageStore(); // re-render on language change
  const t = i18n.getTranslations().EmployerForm;
  const isRTL = i18n.isRTL();
  const [values, setValues] = useState<SubmissionValues>(EMPTY_VALUES);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState(''); // honeypot: hidden from people
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false); // after the first attempt, errors update as you type
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { document.title = `${t.Title} | SKEELZ`; }, [t.Title]);
  useEffect(() => { trackOnce('post_job_view', 'post_job_view'); }, []);

  // Analytics: field NAMES and error codes only — never values (docs/analytics.md §7).
  const trackErrors = (errs: Errors) => {
    for (const [f, code] of Object.entries(errs)) {
      track('post_job_validation_error', { field_name: f, error_code: String(code), step: postJobStepOf(f).step });
    }
  };
  const onFieldFocus = (ev: React.FocusEvent<HTMLFormElement>) => {
    const id = (ev.target as HTMLElement).id || '';
    if (!id.startsWith(`${PREFIX}-`)) return;
    const field = id.slice(PREFIX.length + 1).split('-')[0]; // post-job-jobScope-3 -> jobScope
    if (!(FIELD_ORDER as string[]).includes(field)) return;
    trackOnce('post_job_start', 'post_job_start', { field_name: field });
    const s = postJobStepOf(field);
    trackOnce(`post_job_step:${s.step}`, 'post_job_step', s);
  };
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const change = (patch: Partial<SubmissionValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (submitted) setErrors(validate(next, { consent }));
  };

  const focusFirstError = (e: Errors) => {
    const first = FIELD_ORDER.find((k) => e[k]);
    // The summary is announced; focus moves to the first field that needs fixing.
    setTimeout(() => (first ? document.getElementById(fieldId(PREFIX, first)) : summaryRef.current)?.focus(), 0);
  };

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (sending) return;
    setSubmitted(true);
    setFormError('');
    const e = validate(values, { consent });
    setErrors(e);
    if (Object.keys(e).length) { trackErrors(e); focusFirstError(e); return; }
    track('post_job_submit');
    setSending(true);
    try {
      const res = await fetch('/api/job-submissions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, citySymbol: Number(values.citySymbol), consent, website }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { track('post_job_success'); setDone(true); return; }
      if (res.status === 400 && body?.fields) {
        trackErrors(body.fields);
        setErrors(body.fields);
        focusFirstError(body.fields);
      } else {
        track('post_job_error', { error_code: res.status === 429 ? 'rate_limited' : res.status === 503 ? 'queue_full' : 'server_error' });
        setFormError(res.status === 429 ? t.RateLimited : res.status === 503 ? t.QueueFull : t.GeneralError);
      }
    } catch {
      track('post_job_error', { error_code: 'network' });
      setFormError(t.GeneralError);
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setValues(EMPTY_VALUES); setConsent(false); setErrors({}); setSubmitted(false); setDone(false); setFormError('');
  };

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="p-4 mx-auto" style={{ maxWidth: 900, lineHeight: 1.7 }}>
      {done ? (
        <div role="status">
          <h1 ref={doneRef} tabIndex={-1} className="font-RubikMedium fs-2">{t.SuccessTitle}</h1>
          <p>{t.SuccessBody}</p>
          <div className="d-flex gap-3 flex-wrap">
            <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={reset}>{t.SendAnother}</button>
            <a className="btn bg-color-purple text-white rounded-pill px-4" href={ClientRoutes.MainPage}>{t.BackToJobs}</a>
          </div>
        </div>
      ) : (
        <>
          <h1 className="font-RubikMedium fs-2">{t.Title}</h1>
          <p id={`${PREFIX}-intro`}>{t.Intro}</p>
          <p className="small">{t.RequiredNote}</p>
          <form onSubmit={onSubmit} onFocusCapture={onFieldFocus} noValidate aria-describedby={`${PREFIX}-intro`}>
            <ErrorSummary errors={errors} prefix={PREFIX} summaryRef={summaryRef} />
            <SubmissionFields prefix={PREFIX} values={values} errors={errors} onChange={change} disabled={sending} />

            {/* Honeypot: invisible and unreachable for people (and screen readers); bots fill it. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor={`${PREFIX}-website`}>Website</label>
              <input id={`${PREFIX}-website`} name="website" type="text" tabIndex={-1} autoComplete="off"
                value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>

            <div className="d-flex align-items-start gap-2 mb-3">
              <input className="form-check-input m-0 mt-1 flex-shrink-0" type="checkbox" id={fieldId(PREFIX, 'consent')} checked={consent} required
                disabled={sending} aria-invalid={errors.consent ? true : undefined}
                aria-describedby={errors.consent ? `${fieldId(PREFIX, 'consent')}-error` : undefined}
                onChange={(e) => { setConsent(e.target.checked); if (submitted) setErrors(validate(values, { consent: e.target.checked })); }} />
              <div><label className="form-check-label" htmlFor={fieldId(PREFIX, 'consent')}>
                <span className="color-attention" aria-hidden="true">*</span>{' '}
                {t.ConsentBefore}<a href={ClientRoutes.Privacy} target="_blank" rel="noopener noreferrer">{t.ConsentLink}</a>{t.ConsentAfter}
              </label>
              {errors.consent && <div id={`${fieldId(PREFIX, 'consent')}-error`} className="text-danger small">{t.Required}</div>}
              </div>
            </div>

            <div aria-live="assertive" className="text-danger mb-2">{formError}</div>

            <button type="submit" className="btn bg-color-purple text-white rounded-pill px-5 py-2" disabled={sending} aria-busy={sending}>
              {sending ? t.Sending : t.Submit}
            </button>
          </form>
        </>
      )}
    </div>
  );
};

export default PostJobPage;
