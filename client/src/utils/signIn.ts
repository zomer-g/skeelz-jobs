import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LoginService } from '../services/api/Login.service';
import useAuthStore from '../store/Auth.store';
import useToastStore from '../store/Toast.store';
import { i18n } from '../i18n/I18n';
import { applyContextParams, parseVia, setSsoMethod, track } from './analytics';
import { hasApplyIntent, resumeApplyIntent } from './applyIntent';
import { markFreshSignIn } from './freshSignIn';


const ERROR_TEXT = (code: string): string => {
  const t = i18n.getTranslations().SignIn;
  switch (code) {
    case 'disabled': return t.ErrorDisabled;
    case 'state': return t.ErrorState;
    case 'link_conflict': return t.ErrorLinkConflict;
    case 'no_sso_session': return t.ErrorNoSsoSession;
    case 'staff_google_only': return t.ErrorStaffGoogleOnly;
    case 'ms_unverified_email': return t.ErrorMsUnverifiedEmail;
    case 'cancelled': return t.ErrorCancelled;
    default: return t.ErrorFailed;
  }
};

/**
 * Back from "Continue with Google" (xhostd SSO) the URL carries ?signin=ok, ?signin=signup or ?signin_error=<code>.
 * ok: ask the server who is signed in (the cookies are httpOnly) and fill the auth store; if that candidate's
 * required details are missing, `onIncomplete` (the "complete your details" form). signup: a new Google identity
 * → `onSignup` (the sign-up form; nothing exists yet). An error: say why. The parameter is then removed.
 */
export const useSignInReturn = (handlers: { onSignup?: () => void; onIncomplete?: () => void; onError?: (text: string) => void } = {}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { setUser } = useAuthStore();
  const { showToast } = useToastStore();

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const ok = sp.get('signin') === 'ok';
    const signup = sp.get('signin') === 'signup';
    const error = sp.get('signin_error');
    // The server cleared the password of an existing account that was just linked to Google (pre-account takeover).
    // (password_cleared_ms: the same after "Continue with Microsoft".)
    const notice = sp.get('notice');
    const passwordCleared = notice === 'password_cleared' || notice === 'password_cleared_ms';
    // Which button was used (google / microsoft), for the analytics `method` only.
    const via = parseVia(sp.get('via')) ?? (notice === 'password_cleared_ms' ? 'microsoft' : 'google');
    if (!ok && !signup && !error) return;
    sp.delete('signin');
    sp.delete('signin_error');
    sp.delete('notice');
    sp.delete('via');
    const rest = sp.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash }, { replace: true });

    if (error) {
      // Said in the sign-in window (Header), with the ways to try again; a toast only where there is no window.
      if (handlers.onError) handlers.onError(ERROR_TEXT(error)); else showToast(ERROR_TEXT(error), 'error');
      return;
    }
    if (signup) {
      setSsoMethod(via);
      handlers.onSignup?.();
      return;
    }
    LoginService.getInstance().getSession().then((r) => {
      if (r && typeof r !== 'string' && r.user) {
        const applying = hasApplyIntent();
        // Right after signing in (Google / Microsoft): the consent step if the policy changed (utils/freshSignIn.ts);
        // not when signing in to apply — the apply dialog asks then.
        if (!applying) markFreshSignIn();
        setUser({ ...r.user, jobApplicationsId: r.jobApplicationsId } as any);
        track('login', { method: via, ...applyContextParams() });
        // A one-time notice (an old password was removed) stays; "signed in" is not said on top of an application.
        if (passwordCleared) showToast(i18n.getTranslations().SignIn[notice === 'password_cleared_ms' ? 'PasswordClearedMicrosoft' : 'PasswordCleared'], 'info');
        else if (!applying) showToast(i18n.getTranslations().SignIn.SignedIn, 'success');
        // Missing details: that form first (it goes on with the application when saved); else straight back to applying.
        if ((r as any).profileIncomplete) handlers.onIncomplete?.();
        else resumeApplyIntent();
      } else if (handlers.onError) {
        handlers.onError(ERROR_TEXT('failed'));
      } else {
        showToast(ERROR_TEXT('failed'), 'error');
      }
    });
  }, [location.search]);
};

/** After the app's own sign-out, also leave the xhostd SSO session (else "Continue with Google" signs the same
 *  account straight back in, e.g. on a shared computer). Harmless for password users. */
export const ssoSignOut = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return false;
  const p = await LoginService.getInstance().getProviders();
  if (!p.sso || !p.ssoLogoutUrl) return false;
  window.location.assign(`${p.ssoLogoutUrl}?return_to=${encodeURIComponent('/')}`);
  return true;
};
