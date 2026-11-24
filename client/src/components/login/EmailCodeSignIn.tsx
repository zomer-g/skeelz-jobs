import React, { useEffect, useRef, useState } from "react";
import { EmailCodeVerifyResult, LoginService } from "../../services/api/Login.service";
import { i18n } from "../../i18n/I18n";
import { isString } from "../../utils/utils";
import Button from "../common/Button";
import TextInput from "../common/TextInput";
import StatusMessage from "../common/StatusMessage";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_SECONDS = 60;

interface Props {
  /** A right code for an existing candidate: signed in (`profileIncomplete` → the "complete your details" form). */
  onSignedIn: (r: Extract<EmailCodeVerifyResult, { status: 'signed_in' }>) => void;
  /** A right code for a new address: the sign-up form (nothing is created yet). */
  onSignup: () => void;
  /** The server has the feature off (EMAIL_CODE_SIGNIN_ENABLED): shown greyed out, nothing can be typed or sent. */
  disabled?: boolean;
}

/**
 * "קבלת קוד למייל": email → a 6-digit code by email → signed in, or the sign-up form for a new address.
 * The server answers the same for every address (server/src/controllers/emailSigninController.ts), so this screen
 * never says whether an account exists. "Send again" after 60 seconds (the server's per-address limit).
 */
const EmailCodeSignIn: React.FC<Props> = ({ onSignedIn, onSignup, disabled = false }) => {
  const t = i18n.getTranslations().EmailCode;
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [wait, setWait] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);
  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  const send = async (again = false) => {
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) { setError(t.InvalidEmail); return; }
    setBusy(true); setError(''); setInfo('');
    const r = await LoginService.getInstance().requestEmailCode(e);
    setBusy(false);
    if (isString(r)) { setError(r || t.Failed); return; }
    setEmail(e);
    setCode('');
    setWait(r.resendAfter || RESEND_SECONDS);
    setInfo(again ? t.ResentOk : t.Sent);
    setStep('code');
  };

  const verify = async () => {
    const c = code.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(c)) { setError(t.InvalidCode); return; }
    setBusy(true); setError('');
    const r = await LoginService.getInstance().verifyEmailCode(email, c);
    setBusy(false);
    if (isString(r)) { setError(r || t.Failed); return; }
    if (r.status === 'signup') onSignup();
    else onSignedIn(r);
  };

  const submit = (ev: React.FormEvent) => { ev.preventDefault(); if (!busy && !disabled) (step === 'email' ? send() : verify()); };

  return (
    <form onSubmit={submit} className="d-flex flex-column align-items-center pt-2" data-testid="email-code-sign-in" noValidate
      aria-disabled={disabled || undefined}
      style={disabled ? { opacity: 0.45, filter: 'grayscale(1)', cursor: 'not-allowed' } : undefined}>
      {disabled && <p className="font-RubikMedium text-muted small text-center mb-1 px-3" role="note">{t.ComingSoon}</p>}
      <fieldset disabled={disabled} className="d-flex flex-column align-items-center border-0 p-0 m-0 w-100">
      {step === 'email' ? (
        <div className="w-320px pt-2">
          <TextInput
            required
            label={t.EmailLabel}
            type="email"
            name="signin-email"
            autoComplete="email"
            inputMode="email"
            placeholder={t.EmailLabel}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            aria-invalid={!!error}
            aria-describedby="email-code-status"
          />
        </div>
      ) : (
        <div className="w-320px pt-2">
          <p className="font-RubikRegular mb-1" role="status">{info}</p>
          <p className="font-RubikRegular text-muted small mb-2" dir="ltr" style={{ textAlign: 'right' }}>{email}</p>
          <TextInput
            ref={codeRef}
            required
            label={t.CodeLabel}
            type="text"
            name="signin-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="______"
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/[^\d\s-]/g, '')); setError(''); }}
            aria-invalid={!!error}
            aria-describedby="email-code-status"
          />
          <p className="font-RubikRegular text-muted small mt-2 mb-0">{t.CheckSpam}</p>
        </div>
      )}

      <div className="min-height-2-75rem w-320px pt-2" id="email-code-status" aria-live="polite">
        <StatusMessage message={error} isError className="font-RubikMedium font-responsive-3 text-center" />
      </div>

      <Button
        type="submit"
        disabled={busy}
        className="bg-white border border-2 font-RubikMedium fw-500 btn-h w-320px py-3 rounded-pill d-flex align-items-center justify-content-center"
        customStyle
        style={{ color: '#cd0077', borderColor: '#cd0077' }}
        data-testid={step === 'email' ? 'email-code-send' : 'email-code-verify'}
      >
        {step === 'email' ? (busy ? t.Sending : t.SendCode) : (busy ? t.Checking : t.Verify)}
      </Button>

      {step === 'code' && (
        <div className="d-flex flex-column align-items-center gap-1 pt-3">
          {wait > 0 ? (
            <span className="font-RubikRegular text-muted small" aria-live="polite">{t.ResendIn.replace('{s}', String(wait))}</span>
          ) : (
            <Button customStyle className="font-RubikBold text-decoration-underline text-color-dark-green p-0" onClick={() => send(true)} disabled={busy}>
              {t.Resend}
            </Button>
          )}
          <Button customStyle className="font-RubikRegular text-decoration-underline text-color-dark-green p-0"
            onClick={() => { setStep('email'); setError(''); setInfo(''); setCode(''); }}>
            {t.ChangeEmail}
          </Button>
        </div>
      )}
      </fieldset>
    </form>
  );
};

export default EmailCodeSignIn;
