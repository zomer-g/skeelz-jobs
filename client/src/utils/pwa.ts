// The installable app (docs/pwa.md): service worker registration, "new version" notice, install option.
//
// The worker (public/sw.js) keeps only the public files of the site on the device — never pages, the API, CVs
// or anything personal (candidates' data leaves the server only through the hand-overs, docs/security.md).
import { useSyncExternalStore } from 'react';
import { track } from './analytics';

const hasWindow = typeof window !== 'undefined';

// ---- a tiny store (install option + update notice) ------------------------------------------------------------
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type State = { canPrompt: boolean; installed: boolean; updateReady: boolean };
let state: State = { canPrompt: false, installed: false, updateReady: false };
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePwaState = () => useSyncExternalStore(subscribe, () => state, () => state);

/** Already opened as the installed app (Android / desktop Chrome, iOS home screen). */
export const isStandalone = (): boolean => hasWindow && (
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true);

/** iPhone / iPad: no install prompt; the visitor adds the site from Safari's Share menu. */
export const isIos = (): boolean => hasWindow && (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// ---- registration --------------------------------------------------------------------------------------------
const UPDATE_EVERY_MS = 60 * 60 * 1000;

export function registerServiceWorker() {
  if (!hasWindow || !import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  set({ installed: isStandalone() });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // shown from our own "install the app" option instead of Chrome's mini bar
    deferredPrompt = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    set({ canPrompt: false, installed: true });
    track('pwa_installed');
  });

  // A page already controlled by a worker that gets a new one = a new version of the site was deployed.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) set({ updateReady: true }); });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
      // Phones keep the app open for days: look for a new version every hour while it is in front.
      setInterval(() => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); }, UPDATE_EVERY_MS);
    }).catch(() => { /* no worker: the site works as before */ });
  });
}

// ---- install -------------------------------------------------------------------------------------------------
export type InstallSource = 'footer' | 'menu';

/** Chrome / Edge / Android: the browser's own install dialog. Returns false when there is none (iOS → how-to). */
export async function promptInstall(source: InstallSource): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  try {
    await prompt.prompt(); // refused without a real user gesture: keep the option for the next click
  } catch {
    return true;
  }
  deferredPrompt = null; // the browser's dialog can be shown once per event
  set({ canPrompt: false });
  const { outcome } = await prompt.userChoice;
  track('pwa_install_prompt', { install_source: source, install_outcome: outcome });
  return true;
}

/** iOS: the visitor opened the how-to. */
export const trackIosHowTo = (source: InstallSource) => track('pwa_install_prompt', { install_source: source, install_outcome: 'ios_help' });
