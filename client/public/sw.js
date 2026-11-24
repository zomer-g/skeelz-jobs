/* SKEELZ Jobs service worker (docs/pwa.md).
 *
 * What it keeps on the device: ONLY the public files of the site — the built scripts and styles (/assets/*, their
 * names change every build), icons, fonts, images, the manifest and the offline page. Nothing else.
 *
 * What it NEVER keeps (and never even touches — the browser handles those requests as if there were no worker):
 * the API (/api/*, the public API included), the MCP server (/mcp), sign-in callbacks, robots/sitemap, anything from
 * another site, and every non-GET request. Pages (HTML) are never stored either: a page always comes from the server,
 * and only when there is no connection the offline page is shown instead.
 *
 * Why: candidates' data (lists, applications, CVs, an employer's forwarded applicants) leaves the server only through
 * the hand-overs, with a daily limit, a log entry and alerts (CLAUDE.md, docs/security.md). A copy kept on a device
 * would be readable later without any of that — after sign-out, by the next person using the phone. So the worker
 * stores only files that are the same for every visitor, and refuses anything marked private / no-store or that sets
 * a cookie, even inside the allowed paths.
 *
 * The build (client/vite.config.ts, plugin "skeelz-sw") replaces __SKEELZ_BUILD__ with an id of this build and
 * __SKEELZ_PRECACHE__ with the entry files of index.html. A new id = a new worker = new caches; the old ones are
 * deleted when it takes over.
 */
'use strict';

const BUILD = '__SKEELZ_BUILD__';
const PRECACHE_BUILD = /*__SKEELZ_PRECACHE__*/ [];
const CACHE_PREFIX = 'skeelz-';
const CACHE = `${CACHE_PREFIX}${BUILD}`;
const OFFLINE_URL = '/offline.html';
const SHELL = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png', '/images/logo.svg'];

// ---- the rules (pure; server/test/unit/sw.test.ts checks them) ------------------------------------------------
/** Never handled by the worker: personal or dynamic answers. Every file download (CVs, the employer's forwarded
 *  CVs, a candidate's own CV) and every sign-in / sign-out is under /api, so it is bypassed with the API. */
const NEVER = [/^\/api(\/|$)/, /^\/mcp(\/|$)/, /^\/\.well-known(\/|$)/, /^\/(robots\.txt|sitemap\.xml)$/, /^\/sw\.js$/];
/** Public files that are the same for everyone. /assets/* names carry a content hash: they never change. */
const HASHED = /^\/assets\/[^/]+$/;
const PUBLIC_FILES = [/^\/icons\/[^/]+$/, /^\/fonts\/[^/]+$/, /^\/images\/[^/]+$/, /^\/manifest\.webmanifest$/, /^\/offline\.html$/, /^\/vite\.svg$/];

/**
 * How a request is handled:
 *  'bypass'   — the worker does not answer it (the browser goes to the network as usual; nothing stored)
 *  'asset'    — cache first (hashed build file)
 *  'static'   — from the cache, refreshed from the network in the background (icons, fonts, images, manifest)
 *  'page'     — a page: always from the network, the offline page when there is no connection (never stored)
 */
function routeFor(url, method, mode, origin) {
  if (method !== 'GET') return 'bypass';
  let u;
  try { u = new URL(url); } catch (e) { return 'bypass'; }
  if (u.origin !== origin) return 'bypass';
  const p = u.pathname;
  if (NEVER.some((re) => re.test(p))) return 'bypass';
  if (mode === 'navigate') return 'page';
  if (u.search) return 'bypass'; // a query = not one of our plain files
  if (HASHED.test(p)) return 'asset';
  if (PUBLIC_FILES.some((re) => re.test(p))) return 'static';
  return 'bypass';
}

/** May this answer be stored? Only a plain 200 from this site, public, without a cookie. */
function storable(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const cc = (response.headers.get('cache-control') || '').toLowerCase();
  if (/no-store|private/.test(cc)) return false;
  if (response.headers.get('set-cookie')) return false;
  if ((response.headers.get('vary') || '').trim() === '*') return false;
  return true;
}

self.__skeelzSw = { routeFor, storable, BUILD };

// ---- lifecycle ---------------------------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // The offline page and icons must be there; a build file that fails only means it is fetched later.
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    await Promise.all(PRECACHE_BUILD.map((p) => cache.add(p).catch(() => {})));
    // Take over at once: pages are never stored, so an open page simply keeps using the network for what it needs.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ---- requests ----------------------------------------------------------------------------------------------
async function put(request, response) {
  if (!storable(response)) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: CACHE });
  if (hit) return hit;
  const response = await fetch(request);
  put(request, response.clone()).catch(() => {});
  return response;
}

async function staleWhileRevalidate(event) {
  const hit = await caches.match(event.request, { cacheName: CACHE });
  const fresh = fetch(event.request).then((response) => {
    event.waitUntil(put(event.request, response.clone()).catch(() => {}));
    return response;
  });
  if (hit) { fresh.catch(() => {}); return hit; }
  return fresh;
}

async function page(request) {
  try {
    return await fetch(request); // never stored
  } catch (e) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline || new Response('אין חיבור לאינטרנט', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const route = routeFor(req.url, req.method, req.mode, self.location.origin);
  if (route === 'bypass') return;
  if (route === 'page') event.respondWith(page(req));
  else if (route === 'asset') event.respondWith(cacheFirst(req));
  else if (route === 'static') event.respondWith(staleWhileRevalidate(event));
});
