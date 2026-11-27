// The consent step at sign-in (owner, 23.11.2026; 27.11.2026: only at the moment of signing in). Right after a
// candidate signs in — email code, Google or Microsoft (utils/freshSignIn.ts) — if their terms are not accepted in the
// current version (the policy changed, or one copied from the existing site never accepted them here), they are
// asked here. Opening the site with a session they already had asks nothing (only the small notice at the bottom).
// Boxes (ConsentChecks): terms required; marketing optional and unticked, shown only if they have NOT agreed to it
// (`consent.marketingAgreed` false: never answered, said no, or removed) — someone who agreed sees the terms box only.
// Saved by PUT /users/me/terms (server: profileController.acceptTerms → users + consent_records in one statement,
// source 'first_signin').
//
// "Not now" / closing: they stay signed in and can look around, but can't apply — the server refuses an application
// without the current terms (428 consent_needed) and the apply dialog (ApplyConsentDialog) asks then; the next
// sign-in asks again. Not shown when signing in to apply (the apply dialog asks), nor before the "complete your
// details" form is saved.
import React, { useEffect, useState } from 'react';
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
import { clearFreshSignIn, isFreshSignIn } from '../../utils/freshSignIn';

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
  const userId = user?._id ? String(user._id) : '';
  const candidate = isCandidateUser(user);

  useEffect(() => {
    if (!userId) { setNeed(null); return; }
    // Only right after a sign-in in this tab; a staff / employer-only account has no candidate terms to accept.
    if (!isFreshSignIn() || SKIP_PATHS.includes(pathname)) return;
    if (!candidate) { clearFreshSignIn(); return; }
    let alive = true;
    UserService.getInstance().getMe().then((me) => {
      if (!alive || isString(me) || !me.consent) return;
      // The "complete your details" form comes first; this is checked again when it saved (the user changes).
      if (me.profileIncomplete) return;
      clearFreshSignIn();
      if (me.consent.termsCurrent) return;
      setValues({ consent: false, marketingConsent: false });
      setError(false);
      setFailed(false);
      setNeed({ marketing: !me.consent.marketingAgreed });
    });
    return () => { alive = false; };
  }, [userId, candidate, user, pathname]);

  if (!need || !userId) return null;
  const t = i18n.getTranslations().Terms;

  const later = () => {
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
