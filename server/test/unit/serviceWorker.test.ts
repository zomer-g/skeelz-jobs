// The service worker (client/public/sw.js, docs/pwa.md) keeps only the public files of the site on a device:
// never the API, the MCP server, file downloads, pages, or anything private / with a cookie (candidates' data leaves
// only through the hand-overs — a copy on a device would bypass them). Runs the real file in a sandbox.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const SW = fs.readFileSync(path.join(root, 'client', 'public', 'sw.js'), 'utf-8');
const ORIGIN = 'https://j.skeelz.co.il';

type Rules = {
  routeFor: (url: string, method: string, mode: string, origin: string) => 'bypass' | 'asset' | 'static' | 'page';
  storable: (r: unknown) => boolean;
  BUILD: string;
};
const listeners: Record<string, unknown> = {};
const self: Record<string, unknown> = { addEventListener: (name: string, fn: unknown) => { listeners[name] = fn; }, location: { origin: ORIGIN } };
vm.runInNewContext(SW, { self, URL, Request: class {}, Response: class {}, caches: {}, fetch: () => {} });
const sw = self.__skeelzSw as Rules;
const route = (p: string, mode = 'no-cors', method = 'GET') => sw.routeFor(ORIGIN + p, method, mode, ORIGIN);

test('the worker answers fetches and has its lifecycle', () => {
  for (const e of ['install', 'activate', 'fetch']) assert.equal(typeof listeners[e], 'function', e);
  assert.equal(sw.BUILD, '__SKEELZ_BUILD__', 'the source keeps the placeholder; the build replaces it (vite.config.ts)');
  assert.match(SW, /\/\*__SKEELZ_PRECACHE__\*\/ \[\]/, 'precache placeholder the build replaces');
});

test('never: the API, the MCP server, sign-in, file downloads, robots/sitemap, the worker itself', () => {
  for (const p of [
    '/api/users', '/api/auth/login', '/api/auth/logout', '/api/auth/xhostd/callback?code=x', '/api/auth/microsoft/callback',
    '/api/files/abc/download', '/api/my-cv/file', '/api/employer/applicants/1/cv', '/api/guest-applications/1/cv',
    '/api/internal/v1/files/1', '/api/public/v1/jobs', '/api/public/v1/openapi.json', '/api', '/mcp', '/mcp/x',
    '/.well-known/oauth-authorization-server', '/robots.txt', '/sitemap.xml', '/sw.js',
  ]) {
    assert.equal(route(p), 'bypass', p);
    assert.equal(route(p, 'navigate'), 'bypass', `${p} (navigation)`);
    assert.equal(route(p, 'cors'), 'bypass', `${p} (cors)`);
  }
});

test('never: other sites, non-GET, queries on files, unknown paths', () => {
  assert.equal(sw.routeFor('https://www.googletagmanager.com/gtm.js?id=1', 'GET', 'no-cors', ORIGIN), 'bypass');
  assert.equal(sw.routeFor('https://j.skeelz.co.il.evil.com/assets/a.js', 'GET', 'no-cors', ORIGIN), 'bypass');
  for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) assert.equal(route('/assets/index-abc.js', 'cors', m), 'bypass', m);
  assert.equal(route('/assets/index-abc.js?x=1'), 'bypass');
  assert.equal(route('/icons/icon-192.png?v=2'), 'bypass');
  assert.equal(route('/something.json'), 'bypass');
  assert.equal(route('/assets/sub/dir.js'), 'bypass');
  assert.equal(sw.routeFor('not a url', 'GET', 'no-cors', ORIGIN), 'bypass');
});

test('pages: always from the network (offline page only without a connection), never stored', () => {
  for (const p of ['/', '/job/0123456789abcdef01234567', '/privacy', '/users-management', '/jobs-management',
    '/security-management', '/staff-management', '/employer', '/employer/jobs', '/job-applications-management']) {
    assert.equal(route(p, 'navigate'), 'page', p);
  }
  // The page handler fetches and never writes to the cache.
  const pageFn = SW.slice(SW.indexOf('async function page('), SW.indexOf("self.addEventListener('fetch'"));
  assert.doesNotMatch(pageFn, /put\(|cache\.add|caches\.open/);
});

test('public files: hashed build files cache-first, icons / fonts / images / manifest refreshed', () => {
  assert.equal(route('/assets/index-BfMl41Kj.js'), 'asset');
  assert.equal(route('/assets/index-CVJmDSRp.css'), 'asset');
  for (const p of ['/icons/icon-192.png', '/fonts/Rubik-Medium.ttf', '/images/logo.svg', '/manifest.webmanifest', '/offline.html']) {
    assert.equal(route(p), 'static', p);
  }
});

const res = (status: number, headers: Record<string, string> = {}, type = 'basic') => ({
  status, type, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
});

test('stored only: a public 200 from this site, without a cookie', () => {
  assert.equal(sw.storable(res(200, { 'cache-control': 'public, max-age=31536000, immutable' })), true);
  assert.equal(sw.storable(res(200)), true);
  assert.equal(sw.storable(res(200, { 'cache-control': 'private, no-store' })), false);
  assert.equal(sw.storable(res(200, { 'cache-control': 'no-store' })), false);
  assert.equal(sw.storable(res(200, { 'cache-control': 'private' })), false);
  assert.equal(sw.storable(res(200, { 'set-cookie': 'token=x' })), false);
  assert.equal(sw.storable(res(200, { vary: '*' })), false);
  assert.equal(sw.storable(res(404)), false);
  assert.equal(sw.storable(res(206)), false);
  assert.equal(sw.storable(res(0, {}, 'opaque')), false);
  assert.equal(sw.storable(res(200, {}, 'cors')), false);
  assert.equal(sw.storable(null), false);
});

test('old caches are deleted on activate; the worker takes over at once', () => {
  assert.match(SW, /skipWaiting\(\)/);
  assert.match(SW, /clients\.claim\(\)/);
  assert.match(SW, /n\.startsWith\(CACHE_PREFIX\) && n !== CACHE/);
});

test('the server serves the worker un-cached and allows it in the CSP', () => {
  const index = fs.readFileSync(path.join(root, 'server', 'src', 'index.ts'), 'utf-8');
  assert.match(index, /NO_CACHE_FILES = new Set\(\['sw\.js', 'offline\.html', 'manifest\.webmanifest'\]\)/);
  assert.match(index, /`worker-src 'self'`/);
  assert.match(index, /`manifest-src 'self'`/);
});

test('the client registers the worker only in production builds, in a secure context', () => {
  const pwa = fs.readFileSync(path.join(root, 'client', 'src', 'utils', 'pwa.ts'), 'utf-8');
  assert.match(pwa, /!import\.meta\.env\.PROD/);
  assert.match(pwa, /!window\.isSecureContext/);
  assert.match(pwa, /register\('\/sw\.js'/);
});
