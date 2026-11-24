// The consent step at sign-in (owner, 23.11.2026): a signed-in candidate whose terms are not accepted in their
// current version — one copied from the existing site never accepted them here, and everyone after TERMS_VERSION is
// bumped — is asked right away, whatever the way they signed in (email code, Google, Microsoft): this reads the
// account's state (GET /users/me), not the sign-in path. The same two boxes as everywhere (ConsentChecks): terms
// required, marketing optional and unticked (shown only if never answered). Saved by PUT /users/me/terms (server:
// profileController.acceptTerms → users + consent_records in one statement, source 'first_signin').
//
// "Not now" / closing: they stay signed in and can look around, but can't apply — the server refuses an application
// without the current terms (428 consent_needed) and the apply dialog (ApplyConsentDialog) asks again then. Asked
// again at the next visit (this tab's session only remembers "not now").
import React, { useEffect, useRef, useState } from 'react';
import { Modal } from 'react-bootstrap';
import { useLocation } from 'react-router-dom';
import { i18n } from '../../i18n/I18n';
import { isCandidateUser } from '../../i18n/General.enums';
import { ClientRoutes } from '../../i18n/ClientRoutes.enum';
import useAuthStore from '../../store/Auth.store';
import useToastStore from '../../store/Toast.store';
import { UserService } from '../../services/api/User.service';
import { isString } from '../../utils/utils';
import ConsentChecks, { ConsentValues } from './ConsentChecks';

const LATER_KEY = 'skeelz:signin-consent-later';
const laterFor = (id: string): boolean => { try { return window.sessionStorage.getItem(LATER_KEY) === id; } catch { return false; } };
const setLater = (id: string) => { try { window.sessionStorage.setItem(LATER_KEY, id); } catch { /* private mode */ } };

// Pages where the dialog would be in the way: the policy itself and the one-click unsubscribe page.
const SKIP_PATHS: string[] = [ClientRoutes.Privacy, ClientRoutes.Unsubscribe];

const SignInConsentDialog: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const { showToast } = useToastStore();
  const { pathname } = useLocation();
  const [need, setNeed] = useState<{ marketing: boolean } | null>(null);
  const [values, setValues] = useState<ConsentValues>({ consent: false, marketingConsent: false });
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // The account checked and found up to date (or answered here): not read again until another account signs in.
  const settled = useRef<string | null>(null);
  const userId = user?._id ? String(user._id) : '';
  const candidate = isCandidateUser(user);

  useEffect(() => {
    if (!userId || !candidate) { setNeed(null); return; }
    if (settled.current === userId || laterFor(userId) || SKIP_PATHS.includes(pathname)) return;
    let alive = true;
    UserService.getInstance().getMe().then((me) => {
      if (!alive || isString(me) || !me.consent) return;
      if (me.consent.termsCurrent) { settled.current = userId; return; }
      // The "complete your details" form comes first; this is checked again when it saved (the user changes).
      if (me.profileIncomplete) return;
      setValues({ consent: false, marketingConsent: false });
      setError(false);
      setFailed(false);
      setNeed({ marketing: me.consent.marketing === null });
    });
    return () => { alive = false; };
  }, [userId, candidate, user, pathname]);

  if (!need || !userId) return null;
  const t = i18n.getTranslations().Terms;

  const later = () => {
    setLater(userId);
    setNeed(null);
    // What "not now" means is said in the dialog itself (below the boxes), not in an orange toast after it closed.
  };
  const confirm = async () => {
    if (!values.consent) { setError(true); document.getElementById('signin-consent-consent')?.focus(); return; }
    setSaving(true);
    setFailed(false);
    const r = await UserService.getInstance().acceptTerms(need.marketing ? values.marketingConsent : undefined);
    setSaving(false);
    if (isString(r) || !r.consent?.termsCurrent) { setFailed(true); return; }
    settled.current = userId;
    setNeed(null);
    showToast(t.SignInSaved, 'success');
  };

  return (
    <Modal show onHide={later} centered backdrop="static" dir={i18n.isRTL() ? 'rtl' : 'ltr'} aria-labelledby="signin-consent-title"
      aria-describedby="signin-consent-intro">
      <Modal.Header closeButton closeLabel={t.SignInLater}>
        <Modal.Title id="signin-consent-title" as="h2" className="fs-5 font-RubikBold flex-grow-1">{t.SignInTitle}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p id="signin-consent-intro" className="font-RubikRegular">{t.SignInIntro}</p>
        <ConsentChecks idPrefix="signin-consent" audience="candidate" values={values} disabled={saving}
          onChange={(v) => { setValues(v); if (v.consent) setError(false); }}
          showTerms showMarketing={need.marketing} termsError={error} />
        <p className="font-RubikRegular small text-muted mt-3 mb-0">{t.SignInDeclined}</p>
        {failed && <p className="text-danger small mt-2 mb-0" role="alert">{t.SignInFailed}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" className="btn btn-outline-dark rounded-pill px-4" onClick={later} disabled={saving}>{t.SignInLater}</button>
        <button type="button" className="btn btn-dark rounded-pill px-4" onClick={confirm} disabled={saving}>{t.SignInConfirm}</button>
      </Modal.Footer>
    </Modal>
  );
};

export default SignInConsentDialog;
