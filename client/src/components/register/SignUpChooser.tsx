// Every sign-up (after Google, Microsoft or a code by email) goes straight to its form — no "employer or job seeker?"
// screen (owner, 11.2026). Someone who came from an employer button (/post-job, the employer area; employerApi
// openEmployerLogin) gets EmployerSignUp (docs/employers.md); everyone else — the header's "התחברות", applying for a
// job — is a candidate and gets the existing form (RegisterUser).
// One role per account: an address that already has an account never gets here (it signs in to that account).
import React from 'react';
import RegisterUser, { RegisterMode } from './RegisterUser';
import EmployerSignUp from '../employer/EmployerSignUp';
import { i18n } from '../../i18n/I18n';
import useLanguageStore from '../../store/Language.store';
import useAuthStore from '../../store/Auth.store';
import { LoginService } from '../../services/api/Login.service';
import { RegisterFormValues } from '../../models/interfaces/Props.interfaces';
import { isString } from '../../utils/utils';
import { applyContextParams, track, ssoSignUpMethod } from '../../utils/analytics';
import { forgetSignupPreference, signupPrefersEmployer } from '../employer/employerApi';

const SignUpChooser: React.FC<{
  mode: Extract<RegisterMode, 'sso-signup' | 'email-signup'>; prefill: Partial<RegisterFormValues>;
  onCandidateDone: () => void; onEmployerDone: () => void;
}> = ({ mode, prefill, onCandidateDone, onEmployerDone }) => {
  useLanguageStore();
  const tp = i18n.getTranslations().Profile;
  const [asEmployer] = React.useState(signupPrefersEmployer);

  if (!asEmployer) return <RegisterUser mode={mode} prefill={prefill} onSuccess={onCandidateDone} />;

  const submit = async (values: Record<string, unknown>): Promise<string | null> => {
    const r = mode === 'sso-signup'
      ? await LoginService.getInstance().completeSsoSignup(values)
      : await LoginService.getInstance().completeEmailSignup(values);
    if (isString(r)) return r;
    useAuthStore.getState().setUser({ ...r.user, jobApplicationsId: [] } as any);
    track('sign_up', { method: mode === 'sso-signup' ? ssoSignUpMethod() : 'email_code', account_type: 'employer', ...applyContextParams() } as any);
    forgetSignupPreference();
    onEmployerDone();
    return null;
  };
  return (
    <EmployerSignUp email={String(prefill.email ?? '')} emailHint={mode === 'sso-signup' ? tp.EmailFromGoogle : tp.EmailFromCode}
      prefill={{ firstName: prefill.firstName ?? '', lastName: prefill.lastName ?? '' }}
      submit={submit} />
  );
};

export default SignUpChooser;
