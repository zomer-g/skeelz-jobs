import React, { useEffect, useState } from "react";
import { LoginService, SignInProviders } from "../../services/api/Login.service";
import { applyContextParams, track } from "../../utils/analytics";
import useToastStore from "../../store/Toast.store";
import { i18n } from "../../i18n/I18n";
import useAuthStore from "../../store/Auth.store";
import SignInOptions from "./SignInOptions";
import EmailCodeSignIn from "./EmailCodeSignIn";
import Button from "../common/Button";

interface LoginModalProps {
  onSuccess: () => void;
  /** A right code for a new address: open the sign-up form (the login window closes first). */
  onEmailSignup: () => void;
  /** Signed in, but required details are missing: open the "complete your details" form. */
  onIncomplete?: () => void;
}

/**
 * The sign-in / sign-up window. Three ways in, the same for an existing and a new candidate: "Continue with Google"
 * (xhostd SSO), "Continue with Microsoft", and "Continue with an email code" (opens the email form here).
 * There are no passwords. Staff sign in only with Google. An option the server has off is shown greyed out.
 */
const LoginModal: React.FC<LoginModalProps> = ({ onSuccess, onEmailSignup, onIncomplete }) => {
  const translations = i18n.getTranslations();
  const t = translations.SignIn;
  const setUser = useAuthStore.getState().setUser;
  const { showToast } = useToastStore();
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
            showToast(translations.Login.LoginSuccess, 'success');
            track('login', { method: 'email_code', ...applyContextParams() });
            onSuccess();
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
      <p className="font-RubikRegular text-center text-color-dark-grey pt-4 mb-0 mx-auto w-320px" style={{ whiteSpace: 'normal' }} data-testid="sign-in-intro">{t.Intro}</p>
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
