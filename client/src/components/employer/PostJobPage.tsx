// Public page /post-job: an employer sends a job — without an account (setting 'open', the default) or only from a
// signed-in employer account (setting 'account_required'; docs/employers.md). The server decides (DB role).
// Server: POST /api/job-submissions (server/src/controllers/jobSubmissionController.ts).
// The job is stored as pending and shown nowhere until staff approve it.
import React, { useEffect, useRef, useState } from 'react';
import { i18n } from '../../i18n/I18n';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import useLanguageStore from '../../store/Language.store';
import { track, trackOnce } from '../../utils/analytics';
import { postJobStepOf } from '../../utils/analyticsPolicy';
import ConsentChecks from '../consent/ConsentChecks';
import SubmissionFields, { EMPTY_VALUES, ErrorSummary, Errors, FIELD_ORDER, SubmissionValues, fieldId, validate } from './SubmissionFields';
import useAuthStore from '../../store/Auth.store';
import { isEmployerUser } from '../../i18n/General.enums';
import { openEmployerLogin } from './employerApi';

const PREFIX = 'post-job';

const PostJobPage: React.FC = () => {
  useLanguageStore(); // re-render on language change
  const t = i18n.getTranslations().EmployerForm;
  const te = i18n.getTranslations().Employers;
  const isRTL = i18n.isRTL();
  const user = useAuthStore((s) => s.user) as any;
  // Several roles per account (23.11.2026): anyone holding the employer role posts as the employer.
  const isEmployer = isEmployerUser(user);
  // The setting: null until known (the form shows as before meanwhile only when it turns out 'open').
  const [mode, setMode] = useState<'open' | 'account_required' | null>(null);
  // A signed-in employer: the contact fields start from the account (still editable).
  const accountContact = (): Partial<SubmissionValues> => isEmployer ? {
    contactName: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(), contactEmail: user.email ?? '',
    contactPhone: user.employer?.phone ?? '', companyName: (user.employer?.companyName ?? '').slice(0, 28),
  } : {};
  const [values, setValues] = useState<SubmissionValues>({ ...EMPTY_VALUES, ...accountContact() });
  const [consent, setConsent] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false); // optional, unticked (server/src/security/consent.ts)
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
  useEffect(() => {
    fetch('/api/job-submissions/policy', { credentials: 'same-origin' })
      .then((r) => r.json()).then((b) => setMode(b?.data?.mode === 'account_required' ? 'account_required' : 'open'))
      .catch(() => setMode('open'));
  }, []);
  useEffect(() => { if (isEmployer) setValues((v) => ({ ...v, ...Object.fromEntries(Object.entries(accountContact()).filter(([k]) => !(v as any)[k])) })); }, [isEmployer]);

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
        body: JSON.stringify({ ...values, citySymbol: Number(values.citySymbol), consent, marketingConsent, website }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { track('post_job_success'); setDone(true); return; }
      if (res.status === 401 || res.status === 403) { setMode('account_required'); setFormError(res.status === 401 ? te.PostSignInText : te.PostNotEmployer); return; }
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
    setValues({ ...EMPTY_VALUES, ...accountContact() }); setConsent(false); setMarketingConsent(false); setErrors({}); setSubmitted(false); setDone(false); setFormError('');
  };

  return (
    <div dir={isRTL ? 'rtl' : 'ltr'} className="p-4 mx-auto" style={{ maxWidth: 900, lineHeight: 1.7 }}>
      {done ? (
        <div role="status">
          <h1 ref={doneRef} tabIndex={-1} className="font-RubikMedium fs-2">{t.SuccessTitle}</h1>
          <p>{t.SuccessBody}</p>
          <div className="d-flex gap-3 flex-wrap">
            <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={reset}>{t.SendAnother}</button>
            {isEmployer && <a className="btn btn-outline-dark rounded-pill px-4" href={ClientRoutes.EmployerArea}>{te.AreaTitle}</a>}
            <a className="btn bg-color-purple text-white rounded-pill px-4" href={ClientRoutes.MainPage}>{t.BackToJobs}</a>
          </div>
        </div>
      ) : mode === 'account_required' && !isEmployer ? (
        <section aria-labelledby={`${PREFIX}-signin-title`} className="border rounded-4 p-4 text-center mx-auto" style={{ maxWidth: 620 }}>
          <i className="bi bi-briefcase fs-1" aria-hidden="true" />
          <h1 id={`${PREFIX}-signin-title`} className="font-RubikMedium fs-3 mt-2">{te.PostSignInTitle}</h1>
          {user ? (
            <>
              <p>{te.PostNotEmployer}</p>
              {/* The same account can become an employer too (same email, same sign-in). */}
              <a className="btn bg-color-purple text-white rounded-pill px-5 py-2" href={ClientRoutes.JoinAsEmployer}>הצטרפות גם כמעסיק</a>
            </>
          ) : (
            <>
              <p>{te.PostSignInText}</p>
              <button type="button" className="btn bg-color-purple text-white rounded-pill px-5 py-2"
                onClick={() => openEmployerLogin(() => useAuthStore.getState().setOpenLogin(true))}>{te.PostSignInButton}</button>
            </>
          )}
        </section>
      ) : mode === null ? <p>{te.Loading}</p> : (
        <>
          <h1 className="font-RubikMedium fs-2">{t.Title}</h1>
          <p id={`${PREFIX}-intro`}>{isEmployer ? te.PostSignedInNote : t.Intro}</p>
          {/* Setting 'open': no account needed, but an employer can still sign in (or sign up) from here. */}
          {!user && (
            <aside className="border rounded-4 p-3 mb-3 d-flex flex-wrap align-items-center gap-3" aria-labelledby={`${PREFIX}-employer-signin`} data-testid="post-job-employer-signin">
              <i className="bi bi-briefcase fs-4" aria-hidden="true" />
              <p id={`${PREFIX}-employer-signin`} className="mb-0 flex-grow-1" style={{ minWidth: 220 }}>{te.PostOpenSignInText}</p>
              <button type="button" className="btn btn-outline-dark rounded-pill px-4"
                onClick={() => openEmployerLogin(() => useAuthStore.getState().setOpenLogin(true))}>{te.PostSignInButton}</button>
            </aside>
          )}
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

            <ConsentChecks idPrefix={PREFIX} audience="employer" className="mb-3" disabled={sending}
              values={{ consent, marketingConsent }} termsError={!!errors.consent}
              onChange={(v) => {
                setConsent(v.consent); setMarketingConsent(v.marketingConsent);
                if (submitted) setErrors(validate(values, { consent: v.consent }));
              }} />

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
