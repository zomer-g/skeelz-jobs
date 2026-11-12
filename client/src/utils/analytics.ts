// Funnel tracking for Google Tag Manager / GA4. See docs/analytics.md.
//
// - Off unless the server set GTM_ID or GA_ID (it then writes window.__ANALYTICS__).
// - Nothing is sent until the visitor accepted analytics cookies (consent banner).
// - Every event goes through buildEvent() (utils/analyticsPolicy.ts): only listed
//   events and parameter keys, each value checked. No personal data, ever.
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  buildEvent, consentModeState, CONSENT_STORAGE_KEY, ConsentChoice, errorCodeFrom, EventName, EventParams,
  GA_COOKIE_NAME, PARAM_CHECKS, parseConsent, sanitizePath, sanitizeReferrer, sanitizeUrl, utmFrom,
} from './analyticsPolicy';
import { languageStore } from '../store/Language.store';
import { Language } from '../i18n/General.enums';
import { i18n } from '../i18n/I18n';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    __ANALYTICS__?: { gtm?: boolean; ga?: boolean };
    /** Set by the server (server/src/index.ts): injects gtm.js / gtag.js. Called only after consent. */
    __skeelzLoadAnalytics?: () => void;
  }
}

const hasWindow = typeof window !== 'undefined';
export const CONSENT_EVENT = 'skeelz:consent';

/** True when the server injected GTM or gtag (GTM_ID / GA_ID set). */
export const analyticsEnabled = (): boolean => hasWindow && !!(window.__ANALYTICS__?.gtm || window.__ANALYTICS__?.ga);

const storage = {
  get(key: string, session = false): string | null {
    try { return (session ? window.sessionStorage : window.localStorage).getItem(key); } catch { return null; }
  },
  set(key: string, value: string, session = false) {
    try { (session ? window.sessionStorage : window.localStorage).setItem(key, value); } catch { /* private mode */ }
  },
};

// ---- consent -----------------------------------------------------------------
let consent: ConsentChoice | null = hasWindow ? parseConsent(storage.get(CONSENT_STORAGE_KEY)) : null;

export const getConsent = (): ConsentChoice | null => consent;
export const hasAnalyticsConsent = (): boolean => !!consent?.analytics;

const gtag = (...args: unknown[]) => {
  if (!hasWindow) return;
  if (typeof window.gtag === 'function') { window.gtag(...args); return; }
  window.dataLayer = window.dataLayer || [];
  // gtag() pushes the arguments object itself; GTM reads consent commands only in that shape.
  (function () { window.dataLayer!.push(arguments); } as (...a: unknown[]) => void)(...args);
};

export function setConsent(analytics: boolean) {
  consent = { analytics, at: new Date().toISOString() };
  storage.set(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  if (analyticsEnabled()) {
    gtag('consent', 'update', consentModeState(analytics));
    if (analytics) {
      track('consent_update', { consent_analytics: true });
      trackPageView(); // the page they are on was not counted before consent
      window.__skeelzLoadAnalytics?.(); // Google's scripts load only now (queued events are read on load)
    } else {
      deleteGaCookies();
    }
  }
  if (hasWindow) window.dispatchEvent(new CustomEvent(CONSENT_EVENT));
}

/** Withdrawal: remove Google Analytics cookies (_ga, _ga_<id>) on this host and its parent domains. */
function deleteGaCookies() {
  if (!hasWindow) return;
  const names = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((n) => GA_COOKIE_NAME.test(n));
  const parts = window.location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join('.')}`);
  for (const name of names) {
    for (const d of domains) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
  }
}

/** Footer "cookie settings": show the banner again. */
export function reopenConsent() {
  if (hasWindow) window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: { reopen: true } }));
}

// ---- first-touch UTM (kept for the session; the SPA drops the query on navigation)
const UTM_SESSION_KEY = 'skeelz_utm';
const firstTouchUtm: Record<string, string> = (() => {
  if (!hasWindow) return {};
  const now = utmFrom(window.location.search);
  if (Object.keys(now).length) {
    storage.set(UTM_SESSION_KEY, JSON.stringify(now), true);
    return now as Record<string, string>;
  }
  try { return JSON.parse(storage.get(UTM_SESSION_KEY, true) || '{}'); } catch { return {}; }
})();
const landingReferrer = hasWindow ? sanitizeReferrer(document.referrer) : '';

const context = (): EventParams => ({
  page_path: sanitizePath(window.location.pathname),
  page_location: sanitizeUrl(window.location.href),
  page_referrer: landingReferrer || undefined,
  language: languageStore.getState().currentLanguage === Language.HEBREW ? 'he' : 'en',
  ...firstTouchUtm,
});

// ---- events ------------------------------------------------------------------
const RESET: Record<string, undefined> = Object.fromEntries(Object.keys(PARAM_CHECKS).map((k) => [k, undefined]));

/** Push one funnel event. No-op when analytics is off or not consented. */
export function track(name: EventName, params: EventParams = {}) {
  if (!analyticsEnabled() || !hasAnalyticsConsent()) return;
  const payload = buildEvent(name, { ...context(), ...params });
  if (!payload) return;
  window.dataLayer = window.dataLayer || [];
  // GTM's data model keeps keys from earlier pushes; reset every allowed key so a job_id from
  // job_view does not ride along on a later job_list_view.
  window.dataLayer.push({ ...RESET, ...payload });
  // gtag-only mode (GA_ID without GTM): gtag ignores {event} objects, so send it directly too.
  if (window.__ANALYTICS__?.ga && !window.__ANALYTICS__?.gtm) {
    const { event, ...rest } = payload;
    gtag('event', event, rest);
  }
}

const onceKeys = new Set<string>();
/** Same as track(), at most once per key per page load (e.g. "form shown"). */
export function trackOnce(key: string, name: EventName, params: EventParams = {}) {
  if (onceKeys.has(key)) return;
  if (!analyticsEnabled() || !hasAnalyticsConsent()) return;
  onceKeys.add(key);
  track(name, params);
}

let lastPageView = '';
export function trackPageView() {
  if (!hasWindow) return;
  lastPageView = sanitizeUrl(window.location.href);
  track('page_view');
}

/** Mount once inside the Router: one page_view per route change (path + kept query). */
export function usePageViews() {
  const location = useLocation();
  useEffect(() => {
    if (!hasWindow) return;
    if (sanitizeUrl(window.location.href) === lastPageView) return;
    trackPageView();
  }, [location.pathname, location.search]);
}

/** Error code for an API error message: the i18n enum key it came from (e.g. USER_ALREADY_EXISTS). */
export function errorCode(message: unknown): string {
  const t = i18n.getTranslations() as unknown as Record<string, Record<string, unknown>>;
  const dicts = Object.keys(t).filter((k) => /ErrorMessages$/i.test(k)).map((k) => t[k]);
  return errorCodeFrom(message, dicts);
}

// ---- "came to log in / register from an apply button" ----------------------------
let applyContext: { jobId?: string; at: number } | null = null;
export function setApplyContext(jobId?: string) { applyContext = { jobId, at: Date.now() }; }
/** The job the visitor was applying to when they were sent to log in / register (30 min). */
export function applyContextParams(): EventParams {
  if (!applyContext || Date.now() - applyContext.at > 30 * 60_000) return { source: 'header' };
  return { source: 'apply', job_id: applyContext.jobId };
}
export function clearApplyContext() { applyContext = null; }
