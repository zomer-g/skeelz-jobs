import React from "react";
import { LoginService } from "../../services/api/Login.service";
import { i18n } from "../../i18n/I18n";

interface Props {
  /** Which options the server has on (GET /api/auth/providers). An option that is off stays visible, greyed out. */
  google: boolean;
  microsoft: boolean;
  emailCode: boolean;
  /** "Continue with an email code": LoginModal switches to the email form. */
  onEmailCode: () => void;
}

const BTN = "d-flex align-items-center justify-content-center gap-3 w-320px py-3 rounded-pill text-decoration-none font-RubikMedium fs-5 shadow-sm position-relative";
const ICON = "d-inline-flex align-items-center justify-content-center rounded-circle flex-shrink-0";

const GoogleIcon = () => (
  <svg focusable="false" width="18" height="18" viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/>
    <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z"/>
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>
  </svg>
);
const MicrosoftIcon = () => (
  <svg focusable="false" width="18" height="18" viewBox="0 0 21 21">
    <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
    <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
  </svg>
);
const MailIcon = () => (
  <svg focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#cd0077" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <path d="m3 7 9 6 9-6"/>
  </svg>
);

/** A greyed, unclickable option (the server has it off): same place and size, with "בקרוב". */
const Off: React.FC<{ testId: string; icon: React.ReactNode; label: string }> = ({ testId, icon, label }) => {
  const t = i18n.getTranslations().SignIn;
  return (
    <div className={`${BTN} bg-white text-color-dark-grey border border-2`} data-testid={testId} aria-disabled="true"
      style={{ opacity: 0.45, filter: 'grayscale(1)', cursor: 'not-allowed' }}>
      <span className={ICON} style={{ width: 30, height: 30 }} aria-hidden="true">{icon}</span>
      <span>{label}</span>
      <span className="small font-RubikRegular">({t.ComingSoon})</span>
    </div>
  );
};

/**
 * The three ways in, one under the other, the same size: Google (xhostd SSO; staff sign in only this way),
 * Microsoft (candidates), and a one-time code by email. Each of them also signs a new candidate up.
 * Google and Microsoft are links (full-page navigation), not scripts.
 */
const SignInOptions: React.FC<Props> = ({ google, microsoft, emailCode, onEmailCode }) => {
  const t = i18n.getTranslations().SignIn;
  return (
    <div className="d-flex flex-column align-items-center gap-3 pt-3 pb-2" data-testid="sign-in-options">
      {google ? (
        <a href={LoginService.getInstance().signInUrl()} className={`${BTN} bg-color-purple-btn text-white`} data-testid="google-sign-in">
          <span className={`${ICON} bg-white`} style={{ width: 30, height: 30 }} aria-hidden="true"><GoogleIcon /></span>
          <span>{t.ContinueWithGoogle}</span>
        </a>
      ) : <Off testId="google-sign-in-off" icon={<GoogleIcon />} label={t.ContinueWithGoogle} />}

      {microsoft ? (
        <a href={LoginService.getInstance().microsoftSignInUrl()} className={`${BTN} bg-white text-color-dark-grey border border-2`} data-testid="microsoft-sign-in">
          <span className={ICON} style={{ width: 30, height: 30 }} aria-hidden="true"><MicrosoftIcon /></span>
          <span>{t.ContinueWithMicrosoft}</span>
        </a>
      ) : <Off testId="microsoft-sign-in-off" icon={<MicrosoftIcon />} label={t.ContinueWithMicrosoft} />}

      {emailCode ? (
        <button type="button" onClick={onEmailCode} className={`${BTN} bg-white border border-2`} data-testid="email-code-option"
          style={{ color: '#cd0077', borderColor: '#cd0077' }}>
          <span className={ICON} style={{ width: 30, height: 30 }} aria-hidden="true"><MailIcon /></span>
          <span>{t.ContinueWithEmailCode}</span>
        </button>
      ) : <Off testId="email-code-option-off" icon={<MailIcon />} label={t.ContinueWithEmailCode} />}
    </div>
  );
};

export default SignInOptions;
