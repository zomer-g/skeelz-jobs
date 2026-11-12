import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LoginService } from '../services/api/Login.service';
import useAuthStore from '../store/Auth.store';
import useToastStore from '../store/Toast.store';
import { i18n } from '../i18n/I18n';


const ERROR_TEXT = (code: string): string => {
  const t = i18n.getTranslations().SignIn;
  switch (code) {
    case 'disabled': return t.ErrorDisabled;
    case 'state': return t.ErrorState;
    case 'link_conflict': return t.ErrorLinkConflict;
    case 'no_sso_session': return t.ErrorNoSsoSession;
    default: return t.ErrorFailed;
  }
};

/**
 * Back from "Continue with Google" (xhostd SSO) the URL carries ?signin=ok, ?signin=signup or ?signin_error=<code>.
 * ok: ask the server who is signed in (the cookies are httpOnly) and fill the auth store; if that candidate's
 * required details are missing, `onIncomplete` (the "complete your details" form). signup: a new Google identity
 * → `onSignup` (the sign-up form; nothing exists yet). An error: say why. The parameter is then removed.
 */
export const useSignInReturn = (handlers: { onSignup?: () => void; onIncomplete?: () => void } = {}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { setUser } = useAuthStore();
  const { showToast } = useToastStore();

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const ok = sp.get('signin') === 'ok';
    const signup = sp.get('signin') === 'signup';
    const error = sp.get('signin_error');
    if (!ok && !signup && !error) return;
    sp.delete('signin');
    sp.delete('signin_error');
    const rest = sp.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash }, { replace: true });

    if (error) {
      showToast(ERROR_TEXT(error), 'error');
      return;
    }
    if (signup) {
      handlers.onSignup?.();
      return;
    }
    LoginService.getInstance().getSession().then((r) => {
      if (r && typeof r !== 'string' && r.user) {
        setUser({ ...r.user, jobApplicationsId: r.jobApplicationsId } as any);
        showToast(i18n.getTranslations().SignIn.SignedIn, 'success');
        if ((r as any).profileIncomplete) handlers.onIncomplete?.();
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
