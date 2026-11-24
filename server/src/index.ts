import './security/redact.js'; // first: no personal data in the console from here on
import 'reflect-metadata';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import router, { devRouter } from './routes.js';
import publicApiRouter, { PUBLIC_API_PREFIX } from './public/publicApi.js';
import publicMcpRouter from './public/mcpServer.js';
import appConfig from './config/appConfig.js';
import { migrate, pool } from './config/db.js';
import { rekeyAddressLists } from './services/addressKeyRekey.js';
import { errorMiddleware } from './middleware/errorMiddleware.js';
import { checkEnvVars } from './utils/envChecker.js';
import * as jobDAL from './dal/jobDAL.js';
import * as jobService from './services/jobService.js';
import { isSandbox } from './controllers/syncController.js';
import { onJobsChanged } from './services/jobsCache.js';
import { allDefinitions } from './services/customFieldsService.js';
import { purgeStaleUploads } from './services/s3Service.js';
import { purgeAudit } from './security/audit.js';
import { purge as purgeSubmissions } from './dal/jobSubmissionDAL.js';
import { safeErrorText } from './security/pure.js';
import { salesforceBootMessage } from './config/salesforceSettings.js';
import { startSalesforceWorker } from './services/salesforceSync.js';
import { applyLegacyJobsMode, startLegacyMirror } from './services/legacyJobs.js';
import { applyLegacyCandidatesMode, startCandidatesMirror } from './services/legacyCandidates.js';
import seoRouter, { pageSeoFor, setJobsSource } from './seo/seoRoutes.js';
import { startMailWorker } from './mail/triggers.js';
import { purgeMailRecords } from './mail/mailService.js';
import { headHtml, noscriptHtml, withTitle } from './seo/seoPure.js';

checkEnvVars();
{
  // Salesforce: on only with ENABLE_SALESFORCE=true and valid settings; the problems are named, never a value.
  const m = salesforceBootMessage(appConfig.salesforce);
  console[m.level](m.text);
}

// The built React client (client/dist). One process serves the API and the
// pages, so xhostd runs a single container for the whole board.
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST || path.join(process.cwd(), '..', 'client', 'dist'));
const INDEX_HTML = path.join(CLIENT_DIST, 'index.html');

const GTM_ID = /^GTM-[A-Z0-9]+$/.test(process.env.GTM_ID || '') ? process.env.GTM_ID! : '';
const GA_ID = /^G-[A-Z0-9]+$/.test(process.env.GA_ID || '') ? process.env.GA_ID! : '';

/** JSON that is safe inside an inline <script> (no "</script>" breakout). */
const safeJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// The client expects the active job list in window.__INITIAL_DATA__ (that is how
// a direct /job/<id> link opens its modal). Cached briefly: it is the same for everyone.
let jobsCache: { at: number; jobs: any[] } = { at: 0, jobs: [] };
const activeJobs = async () => {
  if (Date.now() - jobsCache.at < 60_000) return jobsCache.jobs;
  // Same list and order as the board's own request (pinned, then the random hot jobs, then the rest),
  // so the page shows the right list at once and the board does not need to fetch it again.
  const { jobs } = await jobService.getActiveJobsWithoutComments({ includeRandomSponsoredJobs: 'true' } as any);
  jobsCache = { at: Date.now(), jobs };
  return jobs;
};
export const invalidateJobsCache = () => { jobsCache.at = 0; };
onJobsChanged(invalidateJobsCache);

// Shown inside #root until the app's code has loaded (React replaces it on its first render),
// so a slow connection sees a loading indicator instead of a blank page. No text, no data.
const BOOT_PLACEHOLDER =
  '<style>@keyframes skz-boot{to{transform:rotate(360deg)}}</style>' +
  '<div style="display:flex;justify-content:center;padding-top:30vh" aria-hidden="true">' +
  '<div style="width:2.5rem;height:2.5rem;border:.25rem solid #d0d0d0;border-top-color:#212529;border-radius:50%;animation:skz-boot .8s linear infinite"></div>' +
  '</div>';

// Analytics loading (docs/analytics.md §2). Since 15.11.2026 (the owner's decision) measurement needs no consent:
// the site shows a notice (client/src/components/consent/NoticeBanner.tsx) that says so and links to the policy.
//  1. Consent Mode v2 defaults: analytics_storage granted; ads are never granted (the site runs no ads).
//  2. window.__skeelzLoadAnalytics() injects gtm.js / gtag.js (with this request's nonce) on page load.
//  3. What may be sent is still the allowlist in analyticsPolicy.ts (no names, emails, phones, CVs, typed text).
//     GA cookies (_ga, _ga_<id>) live 13 months.
// Keep in step with client/src/utils/analyticsPolicy.ts (CONSENT_STORAGE_KEY, CONSENT_MAX_AGE_DAYS,
// GA_COOKIE_EXPIRES_SECONDS) — server/test/analytics.test.ts checks it.
const GA_COOKIE_EXPIRES_SECONDS = 34128000; // 395 days ≈ 13 months

/**
 * The page URL / referrer as Google may see them, computed in the page BEFORE gtm.js / gtag.js load: the same
 * rules as sanitizeUrl / sanitizeReferrer in client/src/utils/analyticsPolicy.ts (path segments that are not
 * plain route names → ':redacted'; only utm_* and view kept; referrer = origin only). server/test/analytics.test.ts
 * runs this text against the client functions. Exported for that test.
 */
export const URL_SANITIZER_JS =
  String.raw`function __skzTok(v){return typeof v==='string'&&v.length>0&&v.length<=100&&/^[A-Za-z0-9_.\-]+$/.test(v)&&!/\d{7,}/.test(v)}` +
  String.raw`function __skzPath(p){var a=p.split('/').filter(Boolean).map(function(s){var d=s;try{d=decodeURIComponent(s)}catch(e){}` +
  String.raw`return /^[A-Za-z0-9_\-]{1,40}$/.test(d)&&!/\d{7,}/.test(d.replace(/^[a-f0-9]{24}$/,''))?d:':redacted'});return '/'+a.join('/')}` +
  String.raw`function __skzUrl(h){try{var u=new URL(h),k=new URLSearchParams(),K=['utm_source','utm_medium','utm_campaign','utm_term','utm_content','view'];` +
  String.raw`u.searchParams.forEach(function(v,n){if(K.indexOf(n)>=0&&__skzTok(v))k.set(n,v)});var q=k.toString();return u.origin+__skzPath(u.pathname)+(q?'?'+q:'')}catch(e){return ''}}` +
  String.raw`function __skzRef(r){try{return r?new URL(r).origin+'/':''}catch(e){return ''}}`;

const analyticsSnippet = (nonce: string) => {
  if (!GTM_ID && !GA_ID) return '';
  let loader = '';
  if (GTM_ID) {
    loader += `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.nonce='${nonce}';j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');`;
  }
  if (GA_ID) {
    // send_page_view:false — the client sends page_view itself with a cleaned URL (no ?token=, no search text).
    loader += `var g=document.createElement('script');g.async=true;g.nonce='${nonce}';g.src='https://www.googletagmanager.com/gtag/js?id=${GA_ID}';document.head.appendChild(g);` +
      `gtag('js',new Date());gtag('config','${GA_ID}',{send_page_view:false,cookie_expires:${GA_COOKIE_EXPIRES_SECONDS},page_location:__skzUrl(location.href),page_referrer:__skzRef(document.referrer)});`;
  }
  return `<script nonce="${nonce}">window.__ANALYTICS__=${safeJson({ gtm: !!GTM_ID, ga: !!GA_ID })};window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('consent','default',{analytics_storage:'granted',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});` +
    `gtag('set','ads_data_redaction',true);gtag('set','url_passthrough',false);` +
    // Before any Google script: the URL and referrer Google may see (no ?token=, no search text, no ids of people).
    `${URL_SANITIZER_JS}var __skzLoc=__skzUrl(location.href),__skzRefr=__skzRef(document.referrer);` +
    `gtag('set',{page_location:__skzLoc,page_referrer:__skzRefr});dataLayer.push({page_location:__skzLoc,page_referrer:__skzRefr});` +
    `window.__skeelzLoadAnalytics=function(){if(window.__skeelzAnalyticsLoaded)return;window.__skeelzAnalyticsLoaded=true;${loader}};` +
    `window.__skeelzLoadAnalytics();</script>`;
};

const contentSecurityPolicy = (nonce: string) => {
  const analytics = GTM_ID || GA_ID;
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'${analytics ? ' https://www.googletagmanager.com https://www.google-analytics.com' : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `font-src 'self' data:`,
    `img-src 'self' data: https:`,
    `connect-src 'self'${analytics ? ' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com' : ''}`,
    `frame-src ${GTM_ID ? 'https://www.googletagmanager.com' : "'none'"}`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    // The installable app (docs/pwa.md): the service worker and the manifest come only from this site.
    `worker-src 'self'`,
    `manifest-src 'self'`,
  ].join('; ');
};

const startServer = async () => {
  try {
    await migrate();
    console.log('[migrate] done');
    await allDefinitions(); // the added fields (settings screen): loaded before the first job page is served
    // The existing site's jobs: who manages them follows LEGACY_JOBS_MODE (services/legacyJobs.ts).
    await applyLegacyJobsMode();
    // The existing site's candidates: read-only copies or ordinary candidates, by LEGACY_CANDIDATES_MODE (services/legacyCandidates.ts).
    await applyLegacyCandidatesMode();
    // The removal and suppression lists: their own key (MARKETING_OPTOUT_SECRET); known addresses re-keyed (M3, 24.11.2026).
    await rekeyAddressLists();
    if (process.env.SSO_ENABLED !== 'true') {
      console.warn('[sso] SSO_ENABLED is not true: staff (admin / content manager) cannot sign in at all (password and Google are refused for staff)');
    }

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1); // behind the xhostd edge proxy: real client IP for rate limits
    app.set('query parser', 'extended'); // filterOptions[...] arrays, as before

    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
      if (!appConfig.isDevMode) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
      next();
    });
    app.use(compression());

    // Public, unauthenticated, read-only surface (public job data only). Mounted
    // BEFORE the /api CORS, cross-site refusal, cookie and body parsers on purpose:
    // these routers end every request under their prefix themselves, so they
    // never see cookies or auth and never fall through to the site's API.
    // See docs/security.md "Public API and MCP server".
    app.use(PUBLIC_API_PREFIX, publicApiRouter);
    app.use(publicMcpRouter);

    // The client is served from the same origin, so CORS is only needed for
    // explicitly listed origins (the old API echoed ANY origin with credentials).
    const allowed = (appConfig.allowedOrigins || '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
    if (allowed.length) {
      app.use('/api', cors({ origin: allowed, credentials: true, methods: 'GET,HEAD,PATCH,POST,DELETE,OPTIONS' }));
    }

    // Another site may not drive this API from a visitor's browser (cookies are
    // SameSite=strict already; this also covers same-site subdomains).
    // The one exception: the browser coming BACK from Google / auth.xhostd.com / login.microsoftonline.com to a sign-in callback (a top-level
    // GET navigation; the signed state cookie and the identity cookie are checked there).
    const SIGN_IN_CALLBACKS = new Set(['/auth/xhostd/callback', '/auth/microsoft/callback']);
    app.use('/api', (req, res, next) => {
      const site = req.get('sec-fetch-site');
      if (req.method === 'GET' && SIGN_IN_CALLBACKS.has(req.path) && req.get('sec-fetch-mode') === 'navigate') return next();
      if ((site === 'cross-site' || site === 'same-site') && !(req.get('origin') && allowed.includes(req.get('origin')!))) {
        return res.status(403).json({ message: 'Cross-site request refused', code: 'cross_site' });
      }
      next();
    });

    // Answers of the site's API may carry personal data: no browser or proxy keeps them. The public lists
    // (job board, map search, skills, towns) carry none and keep their default caching. A handler may still
    // set its own Cache-Control.
    const PUBLIC_GETS = new Set(['/jobs/active', '/jobs/near', '/skills', '/locations', '/locations-and-districts', '/health-check', '/auth/providers']);
    app.use('/api', (req, res, next) => {
      if (!((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_GETS.has(req.path))) res.setHeader('Cache-Control', 'private, no-store');
      next();
    });

    app.use(cookieParser());
    // Resend's webhook is checked against its exact bytes (the signature), so it gets the raw body; express.json
    // then leaves it alone.
    app.use('/api/webhooks/resend', express.raw({ type: '*/*', limit: '256kb' }));
    app.use(express.json({ limit: '1mb' }));

    // Job writes change the cached list served with the pages.
    app.use(['/api/jobs', '/api/internal/v1/jobs'], (req, _res, next) => {
      if (req.method !== 'GET') invalidateJobsCache();
      next();
    });
    // Approving an employer submission creates a job.
    app.use('/api/admin/job-submissions', (req, _res, next) => {
      if (req.method !== 'GET') invalidateJobsCache();
      next();
    });
    // Development only: sign-in codes for the e2e scripts (never in production; the handlers check again).
    if (appConfig.isDevMode && process.env.NODE_ENV !== 'production') app.use('/api', devRouter);
    app.use('/api', router);
    app.use('/api', (_req, res) => res.status(404).json({ message: 'Not found' }));

    // ---- client ----
    const hasClient = fs.existsSync(INDEX_HTML);
    if (!hasClient) console.warn(`[server] client build not found at ${CLIENT_DIST}`);
    const fallbackTemplate = '<!doctype html><title>SKEELZ</title><div id="root"></div><!--app-data-->';
    // Re-read index.html when the build changes, so the page never names asset
    // files that are no longer there (a rebuild without a restart).
    let templateCache = { mtimeMs: -1, html: fallbackTemplate };
    const getTemplate = () => {
      try {
        const { mtimeMs } = fs.statSync(INDEX_HTML);
        if (mtimeMs !== templateCache.mtimeMs) templateCache = { mtimeMs, html: fs.readFileSync(INDEX_HTML, 'utf-8') };
      } catch { /* no client build: keep the last template */ }
      return templateCache.html;
    };
    getTemplate();

    app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    // A missing build file is a 404, never the HTML page: a page opened before a
    // deploy asks for old file names, and HTML in place of a script breaks the app.
    app.use('/assets', (_req, res) => { res.status(404).setHeader('Cache-Control', 'no-store'); res.type('text/plain').send('Not found'); });
    // The service worker (client/public/sw.js, docs/pwa.md): always checked with the server, so a deploy reaches
    // every device on its next visit (browsers also cap this at 24 h). Its scope is the whole site ('/'), which is
    // where it is served from, so Service-Worker-Allowed is not needed. The offline page and the manifest are
    // small and change with a deploy: revalidated too. The offline page is never indexed.
    const NO_CACHE_FILES = new Set(['sw.js', 'offline.html', 'manifest.webmanifest']);
    app.use(express.static(CLIENT_DIST, {
      index: false, maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (path.dirname(filePath) !== CLIENT_DIST) return;
        const name = path.basename(filePath);
        if (NO_CACHE_FILES.has(name)) res.setHeader('Cache-Control', 'no-cache');
        if (name === 'offline.html') res.setHeader('X-Robots-Tag', 'noindex');
        if (name === 'manifest.webmanifest') res.setHeader('Content-Type', 'application/manifest+json');
      },
    }));

    // robots.txt, sitemap.xml and the optional move to the canonical host (seo/seoRoutes.ts, docs/seo.md).
    setJobsSource(activeJobs);
    app.use(seoRouter);

    // Old Salesforce links use the numeric job number: /job/123 -> /job/<id>.
    app.get('/job/:num(\\d+)', async (req, res, next) => {
      try {
        const id = await jobDAL.findPublicIdByJobNumber(Number(req.params.num));
        if (!id) return next();
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        res.redirect(301, `/job/${id}${qs}`);
      } catch (e) { next(e); }
    });

    app.get('*', async (req, res) => {
      const nonce = crypto.randomBytes(16).toString('base64');
      let jobList: any[] = [];
      try {
        jobList = await activeJobs();
      } catch (e) {
        console.error('[server] could not load jobs for page', (e as Error).message);
      }
      let activeJob = null;
      let activeJobIndex = -1;
      const m = req.path.match(/^\/job\/([0-9a-f]{24})/i);
      if (m) {
        activeJobIndex = jobList.findIndex((j) => j._id === m[1]);
        activeJob = jobList[activeJobIndex] || null;
      }
      const initialData = { jobList: { data: jobList }, activeJob, activeJobIndex };
      // Title, description, robots, canonical, Open Graph, JSON-LD and the status (404 / 410) of this page,
      // plus a <noscript> copy of its content for crawlers that do not run JS (seo/seoPure.ts).
      const seo = await pageSeoFor(req, jobList);
      const html = withTitle(getTemplate(), seo.title)
        .replace('<!--app-head-->', `${headHtml(seo, nonce)}\n    ${analyticsSnippet(nonce)}`)
        .replace('<!--app-html-->', BOOT_PLACEHOLDER + noscriptHtml(seo))
        .replace('<!--app-data-->', `<script nonce="${nonce}">window.__INITIAL_DATA__ = ${safeJson(initialData)}${isSandbox() ? ';window.__SANDBOX__ = true' : ''}</script>`);
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Robots-Tag', seo.robots);
      res.status(seo.status).type('html').send(html);
    });

    app.use(errorMiddleware);

    const PORT = Number(process.env.XHOST_HTTP_PORT || process.env.PORT || appConfig.port || 3000);
    const server = http.createServer(app);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[server] listening on ${PORT}`);
    });

    // Salesforce sync queue (services/salesforceSync.ts): every minute and right after a change. Off → not started.
    startSalesforceWorker();
    // The existing site's jobs, read from Salesforce every few minutes (LEGACY_JOBS_MODE=mirror only).
    startLegacyMirror();
    // The existing site's candidates, read from Salesforce every few minutes (LEGACY_CANDIDATES_MODE=mirror only).
    startCandidatesMirror();

    // Abandoned anonymous CV uploads: at boot, then hourly.
    const purge = () => purgeStaleUploads()
      .then((n) => { if (n) console.log(`[storage] removed ${n} unclaimed uploads`); })
      .catch((e) => console.error('[storage] purge failed', (e as Error).message));
    setTimeout(purge, 30_000).unref();
    setInterval(purge, 60 * 60 * 1000).unref();

    // Activity-log retention: its own timer, independent of anything else.
    const purgeLog = () => purgeAudit()
      .then((n) => { if (n) console.log(`[audit] removed ${n} entries past the retention period`); })
      .catch((e) => console.error('[audit] retention purge failed', safeErrorText(e)));
    setTimeout(purgeLog, 60_000).unref();
    setInterval(purgeLog, 6 * 60 * 60 * 1000).unref();

    // Employer submissions (and their contact details): SUBMISSION_RETENTION_MONTHS after review.
    const purgeSubs = () => purgeSubmissions()
      .then((n) => { if (n) console.log(`[submissions] removed ${n} past the retention period`); })
      .catch((e) => console.error('[submissions] retention purge failed', safeErrorText(e)));
    setTimeout(purgeSubs, 90_000).unref();
    setInterval(purgeSubs, 6 * 60 * 60 * 1000).unref();

    // Service emails: "a job you applied to closed" (off unless turned on in the mail screen), and the send records' retention.
    startMailWorker();
    const purgeMail = () => purgeMailRecords()
      .then((n) => { if (n) console.log(`[mail] removed ${n} send records past the retention period`); })
      .catch((e) => console.error('[mail] retention purge failed', safeErrorText(e)));
    setTimeout(purgeMail, 120_000).unref();
    setInterval(purgeMail, 6 * 60 * 60 * 1000).unref();

    const shutdown = () => {
      server.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
