// "Just signed in" (owner, 27.11.2026): the consent step after a policy change is asked at the moment of signing in —
// Google, Microsoft or a code by email — never when someone merely opens the site with a session they already had.
// The sign-in paths call markFreshSignIn(); SignInConsentDialog reads it once (this tab only, sessionStorage, so the
// SSO round trip through another page keeps it). Not marked when signing in to apply: the apply dialog asks then.
const KEY = 'skeelz:fresh-signin';

export const markFreshSignIn = (): void => {
  try { window.sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked: the apply dialog still asks */ }
};

export const isFreshSignIn = (): boolean => {
  try { return window.sessionStorage.getItem(KEY) === '1'; } catch { return false; }
};

export const clearFreshSignIn = (): void => {
  try { window.sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
};
