import React, { useEffect, useState } from "react";
import { LoginService, SignInProviders } from "../../services/api/Login.service";
import { applyContextParams, track } from "../../utils/analytics";
import { i18n } from "../../i18n/I18n";
import useAuthStore from "../../store/Auth.store";
import useToastStore from "../../store/Toast.store";
import SignInOptions from "./SignInOptions";
import EmailCodeSignIn from "./EmailCodeSignIn";
import Button from "../common/Button";

interface LoginModalProps {
  /** Signed in. `incomplete`: required details are missing (onIncomplete opens that form next). */
  onSuccess: (incomplete: boolean) => void;
  /** A right code for a new address: open the sign-up form (the login window closes first). */
  onEmailSignup: () => void;
  /** Signed in, but required details are missing: open the "complete your details" form. */
  onIncomplete?: () => void;
  /** Opened by "הגש מועמדות": say why signing in is needed and that the application goes on right after. */
  forApply?: boolean;
  /** A sign-in that did not work (e.g. back from Google with an error): said here, in the window, not in a toast. */
  error?: string;
}

/**
 * The sign-in / sign-up window. Three ways in, the same for an existing and a new candidate: "Continue with Google"
 * (xhostd SSO), "Continue with Microsoft", and "Continue with an email code" (opens the email form here).
 * There are no passwords. Staff sign in only with Google. An option the server has off is shown greyed out.
 */
const LoginModal: React.FC<LoginModalProps> = ({ onSuccess, onEmailSignup, onIncomplete, forApply = false, error }) => {
  const translations = i18n.getTranslations();
  const t = translations.SignIn;
  const setUser = useAuthStore.getState().setUser;
  const [providers, setProviders] = useState<SignInProviders | null>(null);
  const [view, setView] = useState<'options' | 'email'>('options');
  useEffect(() => {
    let alive = true;
    LoginService.getInstance().getProviders().then((p) => { if (alive) setProviders(p); });
    return () => { alive = false; };
  }, []);

  if (!providers) return <div className="pb-4" aria-busy="true" />;

  if (view === 'email') {
    return (
      <section className="pb-4" aria-labelledby="email-code-title">
        <h2 id="email-code-title" className="font-RubikMedium fs-6 text-center text-color-dark-grey pt-4 mb-0 px-3">
          {translations.EmailCode.Title}
        </h2>
        <EmailCodeSignIn
          disabled={!providers.emailCode}
          onSignup={onEmailSignup}
          onSignedIn={(r) => {
            setUser({ ...r.user, jobApplicationsId: r.jobApplicationsId } as any);
            track('login', { method: 'email_code', ...applyContextParams() });
            // Signing in to apply: the application itself follows, no "signed in" toast on top of it.
            if (!forApply) useToastStore.getState().showToast(translations.Login.LoginSuccess, 'success');
            onSuccess(!!r.profileIncomplete);
            if (r.profileIncomplete) onIncomplete?.();
          }}
        />
        <div className="d-flex justify-content-center pt-3">
          <Button customStyle className="font-RubikRegular text-decoration-underline text-color-dark-green p-0"
            onClick={() => setView('options')} data-testid="sign-in-back">
            {t.BackToOptions}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <div className="pb-4">
      {error && (
        <div role="alert" className="apply-note apply-note-stop mx-auto mt-4 w-320px" data-testid="sign-in-error">
          <p className="font-RubikBold mb-1">{translations.ApplyFlow.SignInFailedTitle}</p>
          <p className="font-RubikRegular mb-1">{error}</p>
          <p className="font-RubikRegular mb-0">{translations.ApplyFlow.TryAgain}</p>
        </div>
      )}
      <p className="font-RubikRegular text-center text-color-dark-grey pt-4 mb-0 mx-auto w-320px" style={{ whiteSpace: 'normal' }} data-testid="sign-in-intro">
        {forApply ? translations.ApplyFlow.SignInIntro : t.Intro}
      </p>
      <SignInOptions
        google={!!providers.sso}
        microsoft={!!providers.microsoft}
        emailCode={!!providers.emailCode}
        onEmailCode={() => setView('email')}
      />
      <p className="font-RubikRegular text-center text-muted small pt-2 mb-0 mx-auto w-320px" style={{ whiteSpace: 'normal' }}>{t.NoPasswords}</p>
    </div>
  );
};

export default LoginModal;
