# Security — how candidates' data is protected (developer reference)

Reviewed 2026-11-11 with the app-security-baseline method. Public texts: `client/src/components/privacy/PrivacyPage.tsx`
(`/privacy`). Internal: `docs/privacy/database-definition.md`, `docs/privacy/security-procedure.md`.

## Roles (separation of duties)
| Role (`users.role`) | Sees / does | Gate |
|---|---|---|
| `user` (candidate) | own details and applications | `signedIn` |
| `content_manager` (מנהל תוכן) | `/jobs-management` (create, edit, internal comments), `/users-management` = candidates, applications, CV open/delete — all through `peopleHandover` / `cvHandover`, within the daily limits | `contentManagerOnly` |
| `admin` (מנהל מערכת) | `/security-management` (alerts, usage, grants, access reviews, activity log), `/users-management` = **staff users**; sees **no** candidates (the log shows candidate ids only) | `adminOnly` |
| both staff roles | internal API tokens: list all, revoke any; create — people scopes only by a content manager (checked in the handler) | `staffOnly` |

One role per account; someone who needs both gets two accounts. Staff users (`src/controllers/staffController.ts`,
`/api/admin/staff`): add by email (existing account gets the role; a new one is created **without a password** and its
owner sets one through the reset link — the admin never sets or sees passwords), change role, deactivate
(`users.deactivated_at`: no login, no session), reactivate, revoke sessions (`users.sessions_revoked_at`: refresh tokens
disabled **and** access tokens issued up to that second refused). Lock-out (`staffChangeRefusal`, `src/security/pure.ts`):
the last active admin can't be demoted or deactivated, nobody deactivates themself; staff changes run one at a time.
Content managers can't edit or list staff accounts (`findAll` / `updateUserById({ candidatesOnly })`), so they can't
re-point an admin's email and reset its password.

**Role split migration** (`migrateRolesSplit`, `src/config/db.ts`, once, recorded in `schema_migrations`): the account of
`INITIAL_ADMIN_EMAIL` (else `ADMIN_EMAIL`) stays/becomes admin; every other former admin becomes a content manager and
its sessions are closed. If former admins exist but that email has no account, nothing changes and it retries at the
next boot (fail-closed: former admins keep security only). `ADMIN_EMAIL` is made admin again at every boot
(`bootstrapAdmin.ts`, break-glass). `CONTENT_MANAGER_EMAIL` / `CONTENT_MANAGER_INITIAL_PASSWORD` create a content manager
for local tests only (`DEV_MODE=true`).

## Where the data is
| Data | Where | Who reaches it |
|---|---|---|
| Candidates (`users`, role `user`) | xhostd Postgres | the candidate (own row, via login); content managers |
| Staff (`users`, role `content_manager` / `admin`) | Postgres | admins (staff users screen: email, name, role, state, last login) |
| Applications (`job_applications`) | Postgres | the candidate (own); content managers (counted + logged) |
| CV files | xhostd blob (`post-scan/<token>/<name>`) | content managers only, via `GET /api/files/:userId` (counted + logged) |
| Job internal comments | Postgres `jobs.comments` | content managers only |
| Activity log (`audit_log`) | Postgres, append-only trigger | admins, `/security-management` |
| Security alerts (`security_alerts`) | Postgres | admins (red banner + screen); raised by content managers' usage |
| Guest applications | not stored here; email + Salesforce (when on) | — |
| Employer job submissions (`job_submissions`): the job + the employer's contact name, email, phone | Postgres, kept 12 months after review (`SUBMISSION_RETENTION_MONTHS`) | content managers only (`contentGate` = `contentManagerOnly`), contact details only when one is opened (logged) |
| Internal API tokens (`api_tokens`) | Postgres: SHA-256 hash + prefix, never the token | both staff roles (metadata, revoke); people scopes issued only by content managers |
| Salesforce sync state (`salesforce_sync`) | Postgres: record id, Salesforce Id, times, error code | internal API (`salesforce:push`) |

## Gates (every entry point)
- `signedIn` / `contentManagerOnly` / `adminOnly` (built by `authenticateAndAuthorizeWithJWT(roles, tag)`) and
  `tryExtractTokenPayloadMiddleware` (`src/middleware/jwtAuthMiddleware.ts`): access token, else a refresh token
  **checked against the DB**; then the user is loaded and the **DB role** is used; deactivated accounts and access
  tokens older than `sessions_revoked_at` are refused. New routes import the gates from there.
- `test/gates.test.mjs` walks the router and fails when a route has no gate and isn't on its public list, when a
  candidate/jobs-management route isn't exactly `contentManagerOnly`, or when an `/admin/security|audit|staff` route
  isn't exactly `adminOnly` (and no other route may be admin-gated).
- Public routes: the read-only public API and MCP server (below), health, login/logout, sign-up, password reset, job lists/one job, skills, locations, guest apply,
  anonymous CV upload + cancel of one's own pending upload, the token-protected sandbox export, the employer job form
  (`POST /job-submissions`: 5/hour per IP, honeypot, at most 300 pending, field caps, server-side validation, plain text only).
- Employer submission review (`/admin/job-submissions/*`) sits behind `contentGate` in `routes.ts`, which is
  `contentManagerOnly`. The apply-policy settings (`/admin/settings/apply-policy`) are content-manager-only too.
- A submission is never in `jobs` until approved, so no public query (board, job page, page data, Salesforce) can see
  it. Approval creates the job through `jobsService.createJob` (Salesforce only then, when on). The description is plain
  text, escaped and sanitized at approval; the review screen shows it as text.

## Sign-in (who signs in how)
One rule, in `src/security/pure.ts` (`STAFF_ROLES` = `REVIEWED_ROLES`, `isStaffRole`, `methodAllowedForRole`):
**staff (admin, content manager) sign in only with xhostd SSO; candidates with a password or the same SSO.**
- **"Continue with Google" = xhostd SSO** (`/api/auth/xhostd/start|callback`), for everyone. There is no Google OAuth client
  of ours: xhostd runs the Google sign-in at `/xhost-auth/login` (its own client, any Google account) and sets
  `__Host-xhost_id`, an RS256 JWT. We check it against `https://auth.xhostd.com/xhost-auth/jwks`: RS256 only (key by
  `kid`), issuer `https://auth.xhostd.com`, `aud` = the Host the request came in on, expiry; plus our own state cookie
  (signed, 10 minutes, SameSite=Lax, path `/api/auth`). Mapping: stored `users.xhostd_sub` → that account; else an account
  with the same email → the subject is linked to it (staff or candidate, `auth.sso_linked`); else the **sign-up form**:
  nothing is created yet. The callback sets `sso_signup` (HS256 with our key: subject, email, name from the verified token;
  httpOnly, SameSite=Strict, path `/api/auth`, 20 minutes) and lands on `?signin=signup`. The form (same details and
  rules as "new user", email read-only, no password; `checkProfile` in `pure.ts`) posts to `POST /api/auth/xhostd/signup`,
  which takes the email **only from that cookie**, creates the candidate (`role = 'user'`, linked to the subject,
  `auth.signup_sso`) and signs them in. Abandoned → the cookie expires, nothing exists. SSO never creates staff and never
  changes a role. The token has no `email_verified` claim; the email is the Google account's, as xhostd signs it.
- A candidate without a phone or a town (an account an earlier SSO sign-in created bare) is asked to complete them after
  signing in (`/auth/session` → `profileIncomplete`; the same form, saved through `PATCH /users/me`).
- Password login: a staff account with the right password gets 403 `au10` ("use Continue with Google") and no session.
  The check comes after the password, so the form does not reveal which emails are staff. Password reset: no link is sent
  to staff (same generic answer), and a reset link of a staff account is refused. Staff invites (staff screen) email a
  "sign in with Google" note, never a set-password link.
- Every request: the session's `via` (in the access and refresh tokens) is checked against the user's role **from the DB
  now** — a password session of someone who is (or has since become) staff counts as no session.
- The callback is the only `/api` path the cross-site refusal lets through, and only as a top-level GET navigation.

## Personal area (a candidate's own details)
`GET|PATCH /api/users/me`, `DELETE /api/users/me/cv` (`signedIn`, writes rate-limited): the record is always the
caller's own (id from the session — no id in the path or body is read) and only a candidate's (`role = 'user'`; staff get
403). Fields: the allowlist `PROFILE_FIELDS` (name, phone, town, gender, birth date, skills, profile CV), checked with the
sign-up rules; an empty value never clears a required one; a phone used by another account is refused (`us3`). Email is
read-only for everyone (it is the sign-in name, and the Google identity for SSO accounts; there is no email provider to
re-verify a new one). Role and password can't be set here (password: "forgot password"). A new CV must be an unclaimed
upload and becomes this user's (`claimCvUpload`); removing it clears the profile CV, the file stays for past applications.
Logged as `user.profile_updated` (target `self`, field names only).
- Off unless `SSO_ENABLED=true` (then staff can't sign in at all; the server warns at boot). Issuer/JWKS overrides
  for the mock provider in tests are honoured only with `DEV_MODE=true`.

## Public API and MCP server (`src/public/`)
Unauthenticated, read-only: `GET /api/public/v1/{jobs, jobs/near, jobs/:id, locations, skills, openapi.json}` (+ a docs
page at `/api/public/v1/`) and an MCP server at `POST /mcp` (Streamable HTTP, stateless) with five tools —
`search_jobs`, `get_job`, `jobs_near`, `list_locations`, `list_skills` — all `readOnlyHint: true`, no resources/prompts.
Both call `publicService.ts` only. What protects it:
- **One allowlist serializer:** `toPublicJob` / `toPublicLocation` / `toPublicSkill` (`publicJob.ts`) copy fields by
  name. Out on purpose: internal comments, apply-policy overrides/policy, contact person name/phone/email (shown on the
  site's self-apply job page, but a bulk API would make them harvestable), `uploadBy`, `isMarked`, status, timestamps,
  anything Salesforce. A new DB column cannot leak. `test/public.test.mjs` and `test/e2e.mjs` pin the exact key sets.
- **Active only, explicit:** every query adds `j.status = 'Active'` (`PUBLIC_JOB_WHERE`) and `toPublicJob` returns
  null for any other status. Employer submissions live in `job_submissions` and are never read here.
- **No auth path at all:** the routers are mounted in `index.ts` *before* the site's `/api` CORS, cross-site refusal,
  cookie parser and JSON parser, and end every request under their prefix themselves (data / 400 / 404 / 405), so they
  never read cookies or tokens and never fall through to the site API. An admin's session sees the same public shape.
  Nothing is shared with the internal (token/secret) API.
- **Cross-site exemption, deliberately:** the site's `/api` refuses `Sec-Fetch-Site: cross-site`; the public prefix is
  exempt (by mount order) because its whole point is to be read from other sites. Safe because it is GET-only, sends
  `Access-Control-Allow-Origin: *` **without** credentials, and returns nothing that is not already public. The MCP
  server is outside `/api` and has the same CORS (`*`, no credentials) so browser clients such as MCP Inspector work.
- **GET only:** any other method on `/api/public/v1/*` is 405 (OPTIONS answers the preflight); `/mcp` takes POST only
  (GET/DELETE 405). `test/gates.test.mjs` lists each route with a reason and fails if a non-GET route appears.
- **Bounds:** page size ≤ 100, deepest offset 10,000, text ≤ 100 chars, ≤ 20 filter values, radius ≤ 200 km inside
  Israel, MCP body ≤ 64 KB (`PUBLIC_LIMITS` in `publicParams.ts`). Rate limit per IP: 120/min REST, 60/min MCP.
- Not logged in `audit_log` (no personal data leaves); `Cache-Control: public` + ETag (304).

## Internal API (`/api/internal/v1`, server to server)
Code `src/internalApi/`, spec `docs/internal-api.openapi.yaml`. Separate from the public read-only API (no shared code
path or bypass) and from the user login: its only gate is `internalApiAuth(scopes)` (`src/internalApi/auth.ts`,
tagged `internalApi`; `test/gates.test.mjs` checks every internal route has it, first, with known scopes).
- **Who issues what (separation of duties):** token routes are `staffOnly` (gate `staff`: admin + content manager).
  Both roles list every token's metadata and can revoke any token (an admin keeps oversight). Creating: the handler
  checks the **DB role** (`req.authUser.role`) against `issuableScopes` (`src/internalApi/pure.ts`): the people scopes
  `candidates:read`, `applications:read`, `cvs:read` (`PEOPLE_SCOPES`) only for a content manager; an admin may issue
  `jobs:read`, `jobs:write`, `salesforce:push`. An admin asking for a people scope gets 403 `scope_not_issuable`,
  logged as `access.denied` (`api_token:scope_not_issuable:…`). `salesforce:push` is not a people scope: it sends
  records to Salesforce (logged as `salesforce.pushed`) and returns to the caller only record ids, Salesforce ids and
  status/error codes — never names, contact details or files. The content manager sees the screen on
  `/jobs-management`, the admin on `/security-management`; each is offered only what it may issue.
- **Tokens:** created by a staff member (name, scopes, expiry 1–90 days, default 30). Format
  `skzi_<8 hex>_<43 base64url>` (256-bit random part). Only `sha256(token)` and the prefix are stored; the token is
  shown once. Revoke = effective on the next request. `last_used_at` updated at most once a minute.
  Actor in the log: `token:<prefix>`.
- **Server secret:** `INTERNAL_API_SECRET` (xhostd secret, ≥ 32 chars, else off), compared in constant time
  (`timingSafeEqual` of SHA-256 digests). All scopes. Actor: `system:internal-api`.
- **Scopes:** `jobs:read`, `jobs:write`, `candidates:read`, `applications:read`, `cvs:read`, `salesforce:push`.
  CV files need `cvs:read` plus `candidates:read` / `applications:read`.
- **Refusals:** no/unknown token 401, expired/revoked 401 (`token_expired` / `token_revoked`), missing scope 403;
  all logged as `access.denied` (reason `internal_api:…`, throttled). Cookies are never read; the cross-site refusal
  on `/api` applies; 300 requests/minute per IP.
- **People data:** candidates/applications through `peopleHandover`, CVs through `cvHandover`, with the token (or the
  secret) as `who`: each has its own daily limits and alerts, and an admin grants more on the security screen like
  for an admin. The answers never contain passwords or storage keys (CV = a link to the CV endpoint).
- **Salesforce push:** 409 `salesforce_disabled` while `ENABLE_SALESFORCE` is off (route check + the service refuses
  too). Idempotent: Salesforce Id from `salesforce_sync`, else looked up by the job / candidate / application id
  field on the Case or Contact (field names in `server/src/utils/salesforceUtils.ts`); update, or create if missing. An application pushes its candidate first and attaches its CV
  when its Case is created. `salesforce.pushed` (strict, candidate ids) is written before the first outbound call;
  the outcome is stored per record as a code (`http_400_REQUIRED_FIELD_MISSING`, `auth`, `not_found`, …), never a body.

## Hand-overs (strict log, limits)
`src/security/handover.ts`: `peopleHandover` (candidate lists, someone's applications) and `cvHandover` (CV open).
Order: lock → usage from the log → refuse at the limit (429 + alert) → load → **strict** entry with the ids shown →
send. If the entry can't be written: 503 and nothing is sent. Limits (`src/security/pure.ts` `LIMITS`):
CVs 40/day (alert 20, grant +40); candidates shown 1,500/day (alert 750, grant +1,500), each candidate once a day.
The limits apply to content managers (the only role that sees candidates); alerts go to admins, and only an admin can
grant more (`POST /api/admin/security/grant` accepts active content managers only).
The lock is in-process (one Node process); switch to `pg_advisory_xact_lock` if the app ever runs as several processes.

## Logged actions (`audit_log.action`)
| Action | Strict | Actor | Details |
|---|---|---|---|
| `candidates.shown` | yes | content manager email | filters, page, ids shown, count (new today), cut |
| `candidate.applications_viewed` | yes | content manager | ids [candidate], count |
| `candidate.cv_opened` | yes | content manager | ids [candidate], count 1, via (page), type |
| `data.exported` | yes | `system:sandbox-export` | row counts |
| `candidate.cv_deleted`, `user.updated` (field names only) | no | content manager | ids |
| `job.created`, `job.updated`, `jobs.internal_listed` | no | content manager | title / fields / counts; through the internal API also `ignored` (screen-owned fields it may not change) |
| `job.pinned`, `job.unpinned`, `job.board_updated`, `job.archived`, `job.restored` | no | content manager | `fields` (names only: `pinnedAt`, `isPublic`, `isSponsored`, `publishDate`, `status`, apply-policy overrides, `deletedAt`) — see `docs/jobs-management.md` |
| `settings.apply_policy_updated` | no | content manager | new default values (booleans) |
| `auth.login`, `auth.logout`, `auth.login_failed` (target = typed email), `auth.password_reset_requested`, `auth.password_reset` | no | user / `anonymous:<ip>` | `auth.login`: role, `method` (`password` / `xhostd`) |
| `auth.login_refused_staff_password` | no | the staff email | right password, but staff sign in only with xhostd SSO; no session made |
| `auth.password_reset_refused_staff` | no | `anonymous:<ip>` | target = typed email (request) or none (`via: reset_link`); no link is sent to staff |
| `auth.sso_linked` (first SSO sign-in of an existing account, staff or candidate), `auth.signup_sso` (new candidate, when the sign-up form is sent) | no | staff email / `user:<id>` | role, `has_cv` |
| `user.profile_updated` | no | `user:<id>` (the candidate) | target `self`; `fields` (names only), `removed` for a CV removal |
| `auth.oauth_failed` | no | `anonymous:<ip>` / user | provider, reason code (`state`, `invalid_token`, `expired`, `missing_token`, `already_linked_other`, …) — never tokens |
| `user.signed_up`, `job.applied`, `guest.applied` | no | `user:<id>` / `anonymous:<ip>` | |
| `jobs.submitted`, `jobs.submission_dropped` | no | `anonymous:<ip>` | target = submission id / reason (`honeypot`, `queue_full`); never the contact details |
| `jobs.submissions_listed`, `jobs.submission_viewed`, `jobs.submission_edited`, `jobs.submission_approved`, `jobs.submission_rejected` | no | content manager | status / count / field names only / job id / `has_reason` (never values or the reason text) |
| `access.denied` | no (throttled 10 min) | any | reason |
| `limits.refused`, `security.alert_raised` | no | content manager / `system:limits` | budget, used, allowed |
| `security.quota_granted`, `security.alert_handled`, `security.access_reviewed`, `security.admin_revoked` (staff → candidate role), `audit.searched` | no | admin | `self: true` when about oneself |
| `staff.invited` (target = staff email) | no | admin | role |
| `staff.role_changed` | no | admin | from, to, self |
| `staff.deactivated`, `staff.reactivated` | no | admin | role |
| `staff.sessions_revoked` | no | admin | role, self |
| `staff.roles_split` (once, at the migration) | no | `system:migration` | admin email, number moved to content manager |
| `sandbox.refreshed` | no | admin (sandbox only) | counts |
| `api_token.created`, `api_token.revoked` | no | admin / content manager | target `token:<prefix>`; name, scopes, days, expiry (never the token) |
| `salesforce.pushed` | yes | `token:<prefix>` / `system:internal-api` | kind, record ids, candidate ids, count (written before sending) |

Through the internal API the actor of `candidates.shown`, `candidate.applications_viewed`, `candidate.cv_opened`,
`job.created`, `job.updated` (details `via: internal_api`), `jobs.internal_listed`, `limits.refused` and
`access.denied` is `token:<prefix>` or `system:internal-api`.

Staff are logged by email (`actorName`: admins and content managers, lowercased), candidates as `user:<id>`.
Informational write failures are counted (`auditFailures`) and shown in the admin red banner.
Retention: 24 months (`AUDIT_RETENTION_MONTHS`), purged every 6 h by its own timer (`purgeAudit`); alerts, grants and
reviews too. Employer submissions: 12 months after review, or after sending if never reviewed (`purgeSubmissions`, 6 h). The trigger refuses UPDATE, TRUNCATE, and DELETE of rows younger than 24 months.

## Other protections
- Console output is redacted (`src/security/redact.ts`, imported first): DB errors print as `database error (code)`,
  emails/phones masked, third-party bodies not printed.
- `/api` refuses `Sec-Fetch-Site: cross-site|same-site` (unless the origin is in `ALLOWED_ORIGINS`); cookies are
  `SameSite=strict`, httpOnly; login no longer returns the tokens in the body.
- CV responses: `attachment`, `CSP: sandbox; default-src 'none'`, `CORP: same-origin`, `private, no-store`.
- Candidates list page size ≤ 50 (was 500). Anonymous uploads unclaimed for 24 h are deleted.

## Not covered (honest list)
- The DB owner role can drop the append-only trigger. Stronger: a separate DB role with INSERT/SELECT only on
  `audit_log`, or shipping the log off-site. Not set up (xhostd gives one DB user).
- Staff login is email + password, no 2FA/SSO, no lockout beyond the rate limit (30 per 15 min per IP).
- Files opened directly in Salesforce, emails to the notification address, and SMOOV are outside this log.
- Separation of duties is by policy plus the log, not absolute: an admin can give the content-manager role to an
  account they control (logged as `staff.invited` / `staff.role_changed` and visible in the access reviews). With a
  single admin nobody reviews the admin; add a second admin to close that.
- An admin can confirm their own review and close alerts about themselves (marked `self`); admins have no budgets.
- Inviting a new staff account needs the reset email (`SEND_EMAIL_ENABLED`); while email is off, promote an existing
  account instead.
- A content manager who hits an admin route (or the reverse) is signed out, as before; the client shows each role only
  its own links.
- The in-memory rate limits and the denial throttle reset on restart.
- `react-router-dom` 6.x has a moderate advisory fixed only in 7.x.
- Internal API: a token is a bearer secret; whoever holds it has its scopes until it expires or is revoked. No IP
  allow-list. The rate limit and the 30-tokens-an-hour creation limit are in memory (reset on restart). Data a system
  received through the API is outside this log once it has left.

## Rules for future changes (also in CLAUDE.md)
- A new route that returns candidates uses `peopleHandover`; a new way to open a CV uses `cvHandover`.
- A new route gets a gate, or is added to the public list in `test/gates.test.mjs` with a reason.
- Never compare roles from the token; use `req.authUser.role` (DB).
- Changing `LIMITS` / retention / review period: update `PrivacyPage.tsx` (`PRIVACY_NUMBERS`, date) and the
  docs in the same change — `test/security.test.mjs` checks the numbers match.
- Don't print personal data; `console.*` is redacted, but don't rely on it for new logging.
