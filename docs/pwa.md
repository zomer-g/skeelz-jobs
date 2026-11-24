# The installable app (PWA)

SKEELZ Jobs installs from the browser as an app: it gets its own icon and opens without the browser bar
(`client/public/manifest.webmanifest`, icons in `client/public/icons/`). A small service worker
(`client/public/sw.js`, no plugin) makes repeat visits faster and shows a plain offline page when there is no
connection.

## What is kept on the device

Only the files that are the same for every visitor:

| What | How |
|---|---|
| Built scripts and styles, `/assets/*` (the name carries a content hash, so a file never changes) | cache first; the entry files of `index.html` are fetched when the worker installs |
| Icons, fonts, images, `/manifest.webmanifest`, `/offline.html` | from the cache, refreshed from the network in the background |

## What is never kept (and never touched by the worker)

- **Pages (HTML)**: always from the server. Without a connection the offline page is shown instead
  ("אין חיבור לאינטרנט", "נסו שוב" = load the same address again). So no page — a staff screen, the personal area,
  an employer's screen — is readable offline, before or after sign-out. There is nothing to clear on sign-out.
- **The API** (`/api/*`, the public API `/api/public/v1` included): all candidates' data, applications, CV and other
  file downloads, sign-in, sign-out and the sign-in callbacks (Google, Microsoft, email code).
- `/mcp`, `/.well-known/*`, `robots.txt`, `sitemap.xml`, `sw.js` itself, any other site (Google Tag Manager etc.),
  any request that is not GET, any address with a query (`?…`) other than a page.
- Even inside the allowed paths: an answer that is not a plain 200 from this site, that is marked `private` or
  `no-store`, sets a cookie or has `Vary: *`.

**Why** (`CLAUDE.md`, `docs/security.md`): candidates' data leaves the server only through the hand-overs
(`peopleHandover` / `cvHandover`) — daily limit, a log entry with the ids before the data leaves, alerts. A copy
kept by the worker on a phone or a shared computer would be readable later without any of that. The worker therefore
answers only for public files; everything else goes to the network as if there were no worker. The browser's own
HTTP cache is unchanged: API answers already carry `Cache-Control: private, no-store` (`server/src/index.ts`).

`server/test/unit/serviceWorker.test.ts` (part of `npm test`) runs the real `sw.js` and checks these rules: the API,
`/mcp`, file and sign-in routes, other sites and non-GET are bypassed, pages are never written to the cache, and only
public 200 answers without a cookie are stored.

## Privacy texts

No change to `/privacy`. The worker stores only the site's public files — the same files every visitor gets and the
browser already keeps in its ordinary cache (`/assets` have been cached for a year since launch). Nothing about the
person is stored, nothing is sent anywhere, and there is no new purpose or recipient (the `CLAUDE.md` triggers for a
privacy update). The two install events (below) are part of the measurement the privacy page already describes, and
carry no personal data. If the worker ever stores anything personal or page content, that is a privacy change: update
`PrivacyPage.tsx` / `privacyTexts.ts` and bump the versions as `CLAUDE.md` says — and the hand-over rule above
would forbid it anyway.

## Updates

- The build (`client/vite.config.ts`, plugin `skeelz-sw`) writes a build id (hash of the build's files) and the
  entry files into `dist/sw.js`. Every deploy therefore ships a different `sw.js`.
- The server sends `sw.js`, `offline.html` and the manifest with `Cache-Control: no-cache`, so the browser checks
  for a new worker on every visit (and at least every 24 hours); an open app also checks every hour while in front
  (`client/src/utils/pwa.ts`). The scope is `/` (served from the root), so `Service-Worker-Allowed` is not needed.
  The CSP of every page has `worker-src 'self'` and `manifest-src 'self'`.
- A new worker takes over at once (`skipWaiting` + `clients.claim`) and deletes every older `skeelz-*` cache.
  Pages are never cached, so nothing old is served after a deploy. A page that was already open shows a small
  notice at the bottom, "גרסה חדשה של האתר זמינה — רענון" (`components/pwa/UpdateNotice.tsx`); it keeps working until
  the visitor refreshes. (If it asks for a build file that no longer exists, `entry-client.tsx` reloads it once, as
  before.)
- The worker is registered only in production builds (`vite build`), on HTTPS or localhost. `npm run dev` has none.

## Install option

"התקנת האפליקציה" in the footer, and in the phone menu (signed in). Shown only where it can work and the site is not
already open as the installed app (`display-mode: standalone`, or `navigator.standalone` on iOS):
- Chrome / Edge / Android: the browser's own install dialog (`beforeinstallprompt`).
- iPhone / iPad: a short how-to — Safari → Share → "הוספה למסך הבית".
- Other browsers (Firefox, Safari on a Mac): hidden.

Measured (`docs/analytics.md`): `pwa_install_prompt` (`install_source` footer/menu, `install_outcome`
accepted/dismissed/ios_help) and `pwa_installed`. No personal data.

## Testing locally

1. `cd client && npm run build`, then run the server (`cd server && npx tsc && node dist/index.js`) on
   http://localhost:3100 (localhost counts as a secure context).
2. Chrome / Edge DevTools → Application → Manifest: "Installability" has no errors; Service workers: `sw.js`
   activated; Cache storage: one `skeelz-<build id>` with only `/assets`, icons, fonts, images, manifest, offline page.
3. Network → Offline, open any page (or reload): the offline page. Back online → "נסו שוב" opens the page.
4. Sign in as staff, open `/users-management`, sign out, go offline, open `/users-management`: the offline page
   (no page and no API answer is in the cache).
5. Rebuild the client (any change) and reload: a new `skeelz-<id>` cache, the old one gone; an already-open tab shows
   the "גרסה חדשה" notice.

## Uninstall / clear

- Installed app: Android — long-press the icon → Uninstall (or Chrome → ⋮ → Settings → Apps); desktop Chrome / Edge —
  in the app window ⋮ → Uninstall; iPhone — long-press the icon → Remove App.
- The stored files: browser settings → site settings for j.skeelz.co.il → Clear data; or DevTools → Application →
  Storage → Clear site data.
- To switch the worker off for everyone: replace `client/public/sw.js` with one that deletes its caches and calls
  `self.registration.unregister()`, and stop calling `registerServiceWorker()` in `entry-client.tsx`; deploy.
