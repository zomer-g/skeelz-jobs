# Search engines and link previews (SEO)

Research and the full plan (Hebrew): https://claude.ai/artifact/VwpD6d712XHE23mbVEd99B. Code: `server/src/seo/`
(`seoPure.ts` = the rules, `seoRoutes.ts` = robots.txt, sitemap.xml, the optional host move, `pageSeoFor`).
Tests: `server/test/seo.test.mjs`.

## What the server does for every page

The client is a SPA (no server-side React). For each page the server (`app.get('*')` in `server/src/index.ts`) writes:

- `<title>`, `<meta name="description">`, `<meta name="robots">` + the same in the `X-Robots-Tag` header;
- `<link rel="canonical">` and `og:url`, **only when the page may be indexed** (below);
- Open Graph (`og:site_name`, `og:locale` he_IL, `og:type`, `og:title`, `og:description`) and `twitter:card`;
- JSON-LD: `JobPosting` on a job page, `Organization` + `WebSite` on the board (when indexable);
- a `<noscript>` copy of the content (job text, or the list of job links) inside `#root`, for crawlers and previews
  that do not run JS. People with JS never see it; React replaces `#root` on its first render.
- the right status: 200, **404** for a path the app does not have, for a job that is paused, scheduled or unknown;
  **410** for a job that was public and is closed or archived (with links to the open jobs). The app still loads on
  404 / 410 (the client shows "הדף לא נמצא" for unknown paths).

Staff and personal areas (`/jobs-management…`, `/users-management`, `/security-management`, `/staff-management`,
`/employer`, `/job-Applications-management`) answer 200 as before with `noindex, nofollow`.

**A new client route** must be added to `PUBLIC_PAGES` or `PRIVATE_PREFIXES` in `seoPure.ts`, or it answers 404.
`seo.test.mjs` reads `client/src/i18n/ClientRoutes.enum.ts` and fails if a route is missing.

## Data

Job pages use **only** `toPublicJob` (`server/src/public/publicJob.ts`), the allowlist of the public API. The
employer's contact details are not written to the page head, the JSON-LD or the noscript copy, not even on self-apply
jobs (the app shows them on the job page as before). Nothing about candidates. No new data is collected and nothing is
sent anywhere, so the privacy texts do not change.

`JobPosting` fields: title, description (+ the threshold condition, as the page shows it), datePosted = publish date
(a bump does not make a job new), hiringOrganization = company name, jobLocation = city / district / IL,
employmentType (FullTime → FULL_TIME, PartialTime → PART_TIME), identifier = job number, directApply = true only for
the quick (no account) form. No `validThrough` (jobs have no closing date): a closed job answers 410 and leaves the
sitemap. A job without a city or publish date gets no JobPosting (a half one is an error in Search Console).

## When the site may be indexed

Only when **`ALLOW_INDEXING=true` and the request's host is the host of `PUBLIC_SITE_URL`** (default
`https://jobs.skeelz.co.il`). Everywhere else (j.skeelz.co.il before the cutover, the xhostd.app address, the
sandbox, local) `robots.txt` says `Disallow: /`, every page says `noindex`, `/sitemap.xml` is 404 and there is no
canonical or og:url. So turning indexing on is one step at the cutover (`docs` of the cutover plan, day 4):
`PUBLIC_SITE_URL` = the final address, `ALLOW_INDEXING=true`.

When indexable, `robots.txt` allows everything except `/api/` (the public API docs page `/api/public/v1/` stays
allowed), `/mcp` and the staff areas, and names `/sitemap.xml` (the board, `/privacy`, `/developers`, `/post-job` and
every public job, `lastmod` = its last change).

## Optional: one host

`REDIRECT_TO_CANONICAL=true` (off by default; only works with `ALLOW_INDEXING=true`): a page requested on any other
host of this app gets 301 to the same path and query on `PUBLIC_SITE_URL`. The API, the sign-in callbacks
(`/api/auth/...`), `/mcp`, `/assets` and `/.well-known` are never moved, so sign-in and integrations keep working on
every host. Turn it on only after jobs.skeelz.co.il points at this app (otherwise pages would move to the old site).

## The owner's steps (not in code)

- Search Console: a Domain property for `skeelz.co.il` (TXT record in DNS); at the cutover submit
  `https://jobs.skeelz.co.il/sitemap.xml`. Same domain and the same `/job/<_id>` addresses → no Change of Address.
- Link Search Console to the GA4 property of this site (p563854648, the owner's SKEELZ account). Never the
  GUY@SKEELZ account.
- A share image (1200×630 PNG with the logo) and a real favicon: then add `og:image` in `headHtml`.
- Links from www.skeelz.co.il to the board and to jobs.
- PageSpeed (pagespeed.web.dev) on mobile, before and after.
