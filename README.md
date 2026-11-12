# SKEELZ Jobs on xhostd

The SKEELZ job board (jobs.skeelz.co.il), running as **one** xhostd app.

## Setup

| Area | How it works |
|---|---|
| Processes | One Node process: API + built React client |
| Database | xhostd Postgres (`pg`, SQL in `server/src/dal`). Ids are 24-hex, so existing `/job/<id>` links keep working |
| CV files | xhostd Blob (private; xhostd injects `S3_*`), through a small built-in client (`server/src/services/blobClient.ts`). Type check by magic bytes, PDF re-saved, DOCX macros rejected. Download is content-manager-only |
| Email | **none**: no email provider; `sendEmail` only logs |
| Salesforce / SMOOV | **off** unless `ENABLE_SALESFORCE` / `ENABLE_SMOOVE` = `true` |
| Analytics | none unless `GTM_ID` / `GA_ID` are set |
| robots.txt | `Disallow: /` unless `ALLOW_INDEXING=true` |

### Security baseline (11.11.2026)
Role read from the DB on every request; an append-only activity log (24 months) of every candidate list, CV open and
admin action, written before the data leaves; daily limits per admin (40 CVs, 1,500 candidates) with alerts and
grants; admin access reviews; redacted server logs; a public `/privacy` page. Details: `docs/security.md`,
`docs/privacy/`, the admin screen `/security-management`. Rules for changes: `CLAUDE.md`.

### Separation of duties (11.11.2026)
Three roles: candidate (`user`), **content manager** (`content_manager`: jobs management, candidates, applications,
CVs — within the daily limits) and **admin** (`admin`: security screen, activity log, alerts, grants, access reviews,
and the staff users screen at `/users-management`; sees no candidates). The one-time migration keeps
`INITIAL_ADMIN_EMAIL` (default `ADMIN_EMAIL`) as admin and makes every other former admin a content manager.
Details: `docs/security.md` → Roles.

### Security fixes
- `POST /api/jobs`, `PATCH /api/jobs/:id`: content managers only (were public).
- `DELETE /api/files`: content managers (a candidate's own CV), or a visitor cancelling their **own pending** upload (was public: delete any file, blank any user's CV).
- `GET /api/users/job-applications/:userId`: signed-in, own applications only (content managers: any).
- Sign-up can no longer set `role` (the body was saved as-is, so anyone could register as admin).
- A CV upload can be attached to one owner only; nobody can adopt someone else's file.
- Job description/comments are sanitized on save (`sanitize-html`) and again on render (DOMPurify).
- `GET /api/jobs/:id` returns internal comments to content managers only.
- Guest apply loads the job from the DB instead of trusting the job object sent by the browser.
- Page data is injected with `<`-escaped JSON and a CSP nonce; CSP, `X-Frame-Options`, HSTS.
- CORS no longer echoes any origin with credentials (same-origin; optional `ALLOWED_ORIGINS`).
- Login gives the same error for unknown email and wrong password.
- Guest apply gives the same answer whether or not the email has an account (it answered "user exists").
  Before turning Salesforce on: a guest application with a registered email creates another guest Contact, so check the org's duplicate rules.
- Anonymous CV uploads that nobody attached are deleted after `CV_PENDING_TTL_HOURS` (default 24), at boot and hourly.
- Rate limits on login, sign-up, upload, apply and password reset.
- Whitelisted sort fields, SOQL ids validated, no PII / API keys in logs, emails HTML-escaped.

## Map search

The job list has a "חיפוש במפה" (map search) view (`/?view=map`). The visitor picks a point
(click the map, type a town in the search box, "המיקום שלי" / browser location, or arrow keys
and Enter on the map), picks a max distance (5–100 km), and gets the active jobs in range,
nearest first. The header's skills and job-scope filters still apply. Map: Leaflet +
OpenStreetMap tiles (no key), loaded only when the map view is opened.

- API: `GET /api/jobs/near?lat=&lng=&radiusKm=` (public, lat/lng inside Israel, radius ≤ 200).
  Returns `{ jobs (with distanceKm), total, withoutCoordinates, remote }`. Distance is haversine
  in SQL from the job's town point; jobs whose town has no point are left out and counted in
  `withoutCoordinates`; remote/nationwide jobs are counted in `remote`.
- Coordinates: `locations.lat` / `lng` (WGS84), filled from `server/seed/settlement-coords.json`.
  Source: the Central Bureau of Statistics settlements list (`bycode2024.xlsx`, then 2022 and 2021
  for codes missing from newer files). Its "סמל יישוב" is the board's `citySymbol`; its ITM
  coordinates are converted with pyproj. Regional councils ("מ.א. X") get the average point of the
  council's settlements. About 130 board locations have no point (industrial zones, Gaza-strip and
  PA localities, some renamed councils).
- Backfill (also prod): automatic. Every `migrate()` (at boot and in `launch.sh`) adds the columns
  if missing and copies points from the JSON onto rows whose point differs. `node dist/scripts/migrate.js`
  prints `locations with coordinates: N/M`.
- Regenerate the JSON (dev machine, needs `openpyxl` and `pyproj`):
  `python -I server/seed/build-settlement-coords.py server/seed/settlement-coords.json server/seed/live-snapshot.json bycode2024.xlsx bycode2022.xlsx bycode2021.xlsx`
  (download from `https://www.cbs.gov.il/he/publications/doclib/2019/ishuvim/bycodeYYYY.xlsx`).

## Public API and MCP server (read-only, no auth)

Only what the job board already shows: active jobs (allowlisted fields, no contact person, no internal notes),
locations with coordinates, skills, and the map "near" search. Code: `server/src/public/`; rules: `docs/security.md`.
Docs page: `/api/public/v1/`; OpenAPI: `/api/public/v1/openapi.json`. GET only (others 405), CORS `*` without
credentials, page size ≤ 100, 120 requests/min per IP (MCP 60/min), `Cache-Control` + `ETag`.

```bash
curl 'https://jobs.skeelz.co.il/api/public/v1/jobs?q=developer&limit=5'
curl 'https://jobs.skeelz.co.il/api/public/v1/jobs?location=חיפה&skills=Excel&scope=FullTime'
curl 'https://jobs.skeelz.co.il/api/public/v1/jobs/near?lat=32.0853&lng=34.7818&radiusKm=15'
curl 'https://jobs.skeelz.co.il/api/public/v1/jobs/1794'
curl 'https://jobs.skeelz.co.il/api/public/v1/locations'
curl 'https://jobs.skeelz.co.il/api/public/v1/skills'
```

Lists return `{ data, page, limit, total }` (near adds `remote`, `withoutCoordinates`; each job adds `distanceKm`).
`location` takes city symbols, city names or district names; `skills` takes ids or names (comma-separated).

MCP server: `https://jobs.skeelz.co.il/mcp` (Streamable HTTP, stateless). Tools: `search_jobs`, `get_job`,
`jobs_near`, `list_locations`, `list_skills` — all `readOnlyHint: true`. Add it in Claude.ai as a custom connector with
that URL (no auth). Local check with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3100/mcp --transport http --method tools/list
```

Or open `npx @modelcontextprotocol/inspector` in the browser and use transport "Streamable HTTP" and URL `http://localhost:3100/mcp`.

## Local development

```bash
cd server && npm install && cp .env.example .env
npm run db:local            # PGlite Postgres on :5437 (separate terminal)
npx tsc && node dist/scripts/importFromLive.js && node dist/scripts/bootstrapAdmin.js
cd ../client && npm install && npx vite build
cd ../server && PORT=3100 node dist/index.js
BASE=http://localhost:3100 node test/e2e.mjs   # end-to-end checks (localhost only)
npm run test:unit                              # unit tests (no DB), e.g. which CV goes with an application
BASE=http://localhost:3100 node test/e2e-submissions.mjs   # employer job form (uses up the 5/hour per-IP budget)
BASE=http://localhost:3100 node test/e2e-auth.mjs          # sign-in: password, staff refusals, "Continue with Google" = xhostd SSO (mock)
```

Staff sign in **only with xhostd SSO**, so the e2e scripts sign staff in through a mock xhostd
(`server/test/helpers/mockIdp.mjs`, port 3199). Add to `server/.env` (honoured only with `DEV_MODE=true`):

```
SSO_ENABLED=true
SSO_ISSUER=http://127.0.0.1:3199
SSO_JWKS_URL=http://127.0.0.1:3199/jwks
```

### Sign-in (password, "Continue with Google" = xhostd SSO)

- **Continue with Google** is xhostd's own sign-in (`/xhost-auth/login`, any Google account; nothing to register in Google
  Cloud). On when `SSO_ENABLED=true`.
- Candidates: email + password, or Continue with Google (a new email fills the sign-up form first — email from Google,
  no password — and the account is created when it is sent; an existing candidate is linked).
- Personal area ("אזור אישי" → "הפרטים שלי"): a candidate edits their own details and profile CV (`/api/users/me`); email
  is read-only.
- Staff (admin, content manager): **Continue with Google only**, matched to an existing staff account by subject or email.
  Password login and password reset are refused for staff on the server. Rule: `STAFF_ROLES` in `server/src/security/pure.ts`.
  Details: `docs/security.md`.

### Apply policy (quick apply / CV)

Admins set two site-wide defaults under Jobs → "הגדרות הגשה" (stored in
`app_settings`, key `applyPolicy`): **quick apply** (a guest may apply without
registering) and **quick apply without a CV**. Each job can override either one
in its edit form (`jobs.quick_apply_override`, `jobs.quick_apply_without_cv_override`;
NULL = inherit). Effective value = override ?? default; it is sent with every job
as `applyPolicy` and enforced in `POST /api/jobs/guestApply` (`jb10` quick apply
off, `jb11` CV required). Registered candidates are not affected. Defaults match
the old behaviour: quick apply on, CV optional. The one-shot imports never write
the override columns, so they keep whatever admins set.

### Jobs management (pin to top, publish date, private, crown, delete)

`/jobs-management` (content managers): one table where each job can be bumped to the top of the board (הקפצה),
get a new publish date (a future date = scheduled, hidden until then), be made private (unlisted: not on the board,
map, public API or MCP; the direct link works), get the crown (sponsored), have its apply policy overridden, and be
deleted to an archive (undo / restore; applications are kept). Public order everywhere: pinned first (latest pin on
top), then publish date, newest first. Integrations don't overwrite what is set there. Details:
[`docs/jobs-management.md`](docs/jobs-management.md); e2e: `BASE=http://localhost:3100 node test/e2e-jobs-admin.mjs`.

### CV on apply (registered candidates)

Apply shows the CV on the candidate's profile (name, upload date, view link via
`GET /api/users/me/cv[/file]`, own CV only) and asks to apply with it or update it.
A new upload either replaces the profile CV or is used for that job only. The
application stores the CV it was sent with (`job_applications.cv_file_url`,
`cv_scope`), and that file is attached to the application's Salesforce Case.

### Internal API (server to server)

`/api/internal/v1` is for SKEELZ's own systems. It is separate from the public read-only API. Spec:
[`docs/internal-api.openapi.yaml`](docs/internal-api.openapi.yaml) (internal, not served). Code: `server/src/internalApi/`.

- **Auth:** `Authorization: Bearer <x>`, where x is either a **token** a staff member creates ("מפתחות API פנימיים" on
  `/jobs-management` for a content manager, `/security-management` for an admin; people scopes — candidates,
  applications, CVs — only a content manager can issue; both roles see all tokens and can revoke any;
  name, scopes, expiry 1–90 days, default 30; shown once, stored as a SHA-256 hash with a
  visible prefix `skzi_xxxxxxxx`, revocable, last-used time shown), or the **server secret** `INTERNAL_API_SECRET`
  (xhostd `set_secret`, ≥ 32 chars; unset = off; every scope; logged as `system:internal-api`). Cookies and user
  logins are not accepted.
- **Scopes:** `jobs:read`, `jobs:write`, `candidates:read`, `applications:read`, `cvs:read` (CV files, together
  with `candidates:read` or `applications:read`), `salesforce:push`.
- **Endpoints:** jobs (list incl. Suspended/Closed, get, create, update), candidates (list/get + profile CV),
  applications (list/get with a CV link + that CV), Salesforce (`/salesforce/{jobs|candidates|applications}/:id/push`,
  `/salesforce/push-pending`, `/salesforce/sync`).
- **Limits and log:** each token (and the secret) has its own daily limits, same as an admin (1,500 candidates,
  40 CVs, alerts at half); strict log entries before data leaves. 401/403 are logged as `access.denied`.
- **Salesforce push:** idempotent (finds the record in Salesforce by its id field, updates or creates it). State per
  record in `salesforce_sync` (last pushed at, Salesforce Id, last error code). While `ENABLE_SALESFORCE` is off it
  answers 409 `salesforce_disabled` and calls nothing.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/internal/v1/jobs?status=Suspended
```

Local e2e (server started with `INTERNAL_API_SECRET` in `server/.env`, Salesforce off; restart the server before a
re-run, token creation is limited to 30 an hour per IP):

```bash
cd server && INTERNAL_API_SECRET=... BASE=http://localhost:3100 DATABASE_URL=postgresql://postgres@127.0.0.1:5437/postgres node test/e2e-internal-api.mjs
```

## xhostd

- `install.sh` builds the client (heap 1 GB) and the server, then drops dev deps.
- `launch.sh` migrates, optionally copies public data from the live board
  (`SEED_FROM_LIVE=true`, only when the DB has no jobs), creates the first admin
  (`ADMIN_EMAIL` — the Google address they sign in with; no password; made admin again at every boot), then starts the server
  (heap `WEB_HEAP_MB`, default 192).

### Sandbox channel (copy of prod, safe to write to)

A `sandbox` channel (branch `sandbox`) has its own database. With `SANDBOX=true`,
Salesforce, SMOOV, email, analytics and indexing are forced off, and a yellow
"sandbox" strip shows in the admin header. Its data is **static**: deploys and
restarts keep it. Prod's data is copied (`importFromProd.js`) only:
- at the first boot of an empty sandbox, and
- when an admin presses "משוך נתונים מהפרודקשן" in that strip
  (`POST /api/internal/sandbox-refresh`, admin only, 404 outside the sandbox).
  This replaces all sandbox data; the sandbox's own admin stays signed in.

- prod: secret `SANDBOX_EXPORT_TOKEN` (32+ chars) turns on `GET /api/internal/export`
  (404 otherwise). Users are anonymized there (name, email, phone, birth date, CV
  link; no password hashes). Login tokens and pending uploads are not exported.
- sandbox channel env: `SANDBOX=true`, `SANDBOX_SOURCE_URL=https://<prod-app>.xhostd.app`,
  secret `SANDBOX_SOURCE_TOKEN` (same value), its own `ADMIN_EMAIL`,
  `CLIENT_BASE_URL` = the sandbox address.
- If prod can't be read, nothing changes; an empty sandbox is seeded from the public live board.

Env: `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `RESET_TOKEN_SECRET` (secrets),
`CLIENT_BASE_URL`, `ADMIN_EMAIL` (the admin's Google address), `SSO_ENABLED=true` (staff sign in only with it), optional
`SEED_FROM_LIVE`, `GTM_ID`, `GA_ID`, `ALLOW_INDEXING`, `APPLICATION_NOTIFICATION_EMAIL`,
and, only after approval, Salesforce/SMOOV credentials.
