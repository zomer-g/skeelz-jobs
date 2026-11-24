# SKEELZ Jobs (xhostd) — rules for changes

One Node process: Express API (`server/`) + built React client (`client/dist`). Postgres on xhostd. See README.md,
`docs/security.md` (how candidates' data is protected).

## Security rules (keep these; tests enforce most of them)
- **Every route has a gate.** Import `contentManagerOnly` / `adminOnly` / `signedIn` from
  `server/src/middleware/jwtAuthMiddleware.ts`, or use `tryExtractTokenPayloadMiddleware`. A route without one must be
  added to the public list in `server/test/gates.test.mjs` with a reason, or the test fails.
- **Roles** (owner, 19.11.2026). Jobs management and VIEWING candidates (lists, applications, CVs) → `staffViewers`
  (placement coordinators רכז השמה, content managers AND admins; `VIEWER_ROLES` in `server/src/models/enums.ts`).
  Settings (sign-up fields, apply policy, employer posting), candidates' records, forwards to employers and Salesforce
  pushes → `contentManagerOnly` (content managers AND admins; `CONTENT_ROLES`). A coordinator never sets a threshold
  condition or a job's apply settings, not even through an employer submission / edit request: every job write checks
  `restrictedChanges` / `thresholdNeedsContentManager` (`server/src/security/roleFields.ts`, 403 `content_manager_required`).
  Security, the activity log and staff users (`/admin/security|audit|staff`) → `adminOnly`. Everyone's candidate views
  go through the same hand-overs (limits, strict log, alerts). Add new routes to the lists in `gates.test.mjs`.
- **Settings screen** (owner, 23.11.2026): every setting of the sign-up form, the job form and applying lives on ONE
  screen, `/settings` (`docs/settings.md`), open to every content manager and admin (`contentManagerOnly`), never in the
  jobs / candidates screens. This moved the sign-up fields setting from admin-only to content managers (it was
  `/admin/security/signup-fields`; now `/admin/settings/signup-fields`). Content managers add their own fields to both
  forms (`custom_fields`; answers `users.custom_fields` / `jobs.custom_fields`, by field id): checked by the server
  (`models/schemas/customFields.ts`), never deleted (turned off), sign-up answers like the ID number — not on `rowToUser`,
  staff see them only through `peopleHandover`, never employers, analytics or a log (ids only). Added JOB fields also
  appear in the employer form and edit requests, and (only those marked "show on the job page") in the public API / MCP
  (owner, 23.11.2026). Salesforce: an added field is sent only after an admin linked it to a field the owner created in
  the org (`custom_fields.sf_field`, checked by describe; Contact / the Position Case) — the site never creates fields
  there (`docs/settings.md`). **A sign-up question is asked only after an ADMIN turns it on** (owner, 24.11.2026: it may
  touch sensitive information): a content manager's new or reworded one is saved off, awaiting an admin (403
  `admin_approval_required` on turning it on; `approved_by` / `approved_at`, `settings.custom_field_approved`).
- **Employers** (role `employer`, `docs/employers.md`) open only `/employer/*` (`employerOnly`); no other gate admits them
  (`signedIn` = candidates + staff). Of candidates an employer sees ONLY the name + CV of applications a content manager
  forwarded ("העברה למעסיק", `employer_forwards`) for their own non-imported job, until 90 days after it closed, through
  the hand-overs with the employer budgets (`employerPeople` / `employerCvs`). Never an email, phone, other field, count or
  anything not forwarded. Their edit requests may ask to change EVERY field of their job (owner, 24.11.2026: contact, status,
  apply settings, every added field — staff-only ones write-only; never pin / sponsored / dates / comments) and change it only
  when a coordinator or content manager approves (a threshold condition or an apply setting: a content manager). Several roles per account (owner, 23.11.2026): a person adds the employer / candidate role to their own account
  (`POST /users/me/roles/employer|candidate`, gate `anyAccount`, used nowhere else); only an admin adds a staff role.
  Each role keeps its own gate, hand-overs and limits; the employer budgets belong to the account (`user:<id>`).
- **Every signed-in person is a candidate** (owner, 24.11.2026; `docs/security.md`): the candidate role is added when they
  apply, never silently — "הגש מועמדות" on an account without it opens the candidate step INSIDE the apply dialog (the
  sign-up form + consent → `POST /users/me/roles/candidate`), then the application goes on. Only a usable candidate role
  applies: `POST /jobs/apply` refuses any other session first (403 `candidate_role_needed` / `role_blocked`).
- **Apply flow: no toasts** (owner, 24.11.2026; `docs/jobs-management.md` "Ways to apply"). A signed-out visitor on a job
  without quick application signs in and lands straight on that job's apply step (`utils/applyIntent.ts`: job id only,
  same-site `/job/<id>` only). Refusals and errors are said in place, inside the dialog next to the button
  (`role="alert"`, `.apply-note`), never in an orange corner toast.
- **Roles come from the DB, never from the token.** Read `req.authUser.role` / `req.authUser.roles` /
  `req.authJwtPayload.userRole` (all set from the DB by the middleware). Don't decode JWTs yourself.
- **Several roles per account** (owner, 23.11.2026; `docs/security.md`). `users.roles` is the set and the source of
  truth; `users.role` is derived by a DB trigger (the highest role). Check a role with `isCandidate` / `isEmployer` /
  `rolesOf` (`models/enums.ts`) or `'user' = ANY(roles)` in SQL, never `role = 'user'` / `role = 'employer'`. Gates
  open on ANY role of the session (`req.authUser.roles`); staff roles count only on a Google (xhostd SSO) session
  (`security/pure.ts effectiveRoles`). At most one staff role per account.
- **Blocking a role** (owner, 24.11.2026; `docs/security.md`): an admin blocks candidate / employer / staff of one account,
  one by one (`users.blocked_roles`, `/api/admin/role-blocks`, adminOnly). A blocked role stays in `roles` but counts for
  nothing: decide what a person may do with `usableRolesOf` (never `rolesOf`) — the gates and every sign-in
  (`authService.issueSession`, all paths) do. Blocking or removing a role closes every session of the account (and its API
  keys); they sign in again with the roles still open. The person never adds a blocked role back (403 `role_blocked`).
- **Anything that returns candidates goes through `peopleHandover`; any way to open a CV goes through `cvHandover`**
  (`server/src/security/handover.ts`): daily limit, strict log entry with the ids shown before the data leaves, alerts.
- **Admin actions are logged** with `writeAudit(actorOf(req), '<area>.<verb>', target, details)`. Add new action names
  to the table in `docs/security.md` and to `ACTION_LABELS` in `client/src/components/security/SecurityManagement.tsx`.
  Never put passwords, tokens or field values of a candidate in `details` (field names only).
- **The activity log is append-only** (DB trigger) and kept 24 months. Don't add code that updates or deletes it;
  `purgeAudit` is the only delete.
- **No personal data in console output.** `security/redact.ts` masks it, but log ids and codes, not emails, names,
  phone numbers or third-party response bodies.
- **The privacy texts must stay true, in plain language** (owner, 20.11.2026: public, accessibility regulations'
  plain-language rule). They say WHAT is done — what is collected, why, who receives it, that there are limits, a log and
  alerts — never internal numbers (`LIMITS`, thresholds, review / retention periods; `npm test` keeps digits out), so
  tuning those needs no text change. Collecting something new, a new purpose or a new kind of recipient → update
  `client/src/components/privacy/PrivacyPage.tsx` / `privacyTexts.ts` (short sentences, each fact once), then regenerate
  `docs/privacy/*.md` (`cd server && npx tsx ../docs/privacy/build-docs.ts`).
- **Every privacy version is kept, every acceptance is recorded** (owner, 19.11.2026). Any change to the `/privacy` text →
  bump `TERMS_VERSION` (`security/consent.ts`) and `PRIVACY_VERSION` (`privacyTexts.ts`) together, then
  `cd client && npm run snapshot:privacy` (writes `server/privacy-versions/<id>.html`; a published file is never edited).
  Every place that stores a consent also inserts into `consent_records` (append-only) in the same statement.
- Salesforce, SMOOV, email, sign-in by email code and analytics stay off unless the owner turns them on (`ENABLE_*`,
  `SEND_EMAIL_ENABLED`, `EMAIL_CODE_SIGNIN_ENABLED`, `GTM_ID`).
- **Search engines** (`docs/seo.md`, `server/src/seo/`): the server writes each page's title, description, robots,
  canonical, Open Graph, JSON-LD and status (404 unknown path / non-public job, 410 closed or archived job), job data only
  through `toPublicJob`. Indexed only with `ALLOW_INDEXING=true` on the `PUBLIC_SITE_URL` host. A new client route goes
  into `PUBLIC_PAGES` or `PRIVATE_PREFIXES` in `seoPure.ts`, or it answers 404 (`test/seo.test.mjs` checks).
- Public pages: the job board, a job page, `/privacy`, `/developers` (API + MCP docs; numbers checked by `test/public.test.mjs`). `/jobs-management` is for coordinators, content managers and admins, `/settings` for content managers and admins, `/security-management` and
  `/staff-management` admin-only, `/users-management` shows candidates to all three staff roles (coordinators view only; client guard + server gates).

## Tests
- `cd server && npx tsc && npm test` — unit tests (limits arithmetic, dates, reviews, redaction, privacy numbers) and
  the gate coverage test.
- **All e2e suites at once: `cd server && npx tsc && node test/run-local.mjs [suite …]`** — each suite on a FRESH pglite
  (`--max-connections=20`) seeded by `test/local-setup.mjs` and a fresh server (`server/.env.example` + the suite's extra
  values, e.g. e2e-mail's `APPLICATION_NOTIFICATION_EMAIL` / `MAIL_WORKER_MS` / `RESEND_WEBHOOK_SECRET`, the mock Salesforce,
  `INTERNAL_API_SECRET`), then a pass table. Local only; refuses busy ports. To run one suite by hand: `npm run db:local`,
  `DATABASE_URL=… node test/local-setup.mjs` (cities, skills, the snapshot's jobs as imported jobs, dev staff — a fresh DB has
  none and the job lists join `locations`), start the server, then the line below. A check that needs an imported job seeds
  one with `DATABASE_URL` (`test/helpers/localDb.mjs`) and is reported **SKIP** (never counted as passed) without it.
- `BASE=http://localhost:3100 node test/e2e.mjs` — end-to-end checks (local server only; needs the dev admin and
  content manager from `server/.env.example`; applies only to jobs made in the suite, never a board job of the existing site).
- `BASE=http://localhost:3100 node test/e2e-submissions.mjs` — employer job form: submit → private → approve/reject
  (14 checks; restart the server before re-running — it spends the per-IP submission limit).
- `BASE=http://localhost:3100 node test/e2e-coordinator.mjs` — placement coordinator (רכז השמה): admin invites → Google
  sign-in → sees candidates / applications / CVs through the hand-overs, manages jobs and approves employer submissions,
  refused (403 `content_manager_required`) on threshold conditions and apply settings, refused on settings, candidate
  edits, forwards, Salesforce, API keys and admin areas; role change logged (9 checks; spends 2 per-IP submissions).
- `BASE=http://localhost:3100 node test/e2e-jobs-admin.mjs` — jobs-management screen: pin order on every public listing,
  private / scheduled / archived hidden from the public API and MCP, soft delete + restore, integrations can't overwrite
  the board, jobs imported from the existing site read-only; the API keys for the integration checks are minted by the admin (admin-only) (13 checks). Rules: `docs/jobs-management.md`.
- `BASE=http://localhost:3100 [DATABASE_URL=…] node test/e2e-threshold.mjs` — threshold condition (תנאי סף): staff set /
  change / clear it (plain text, 3–500), job page + board + public API + MCP carry it, no condition → apply as before,
  condition → regular, job-only CV and quick applications refused without `thresholdConfirmed: true` (400
  `threshold_not_confirmed`, nothing claimed) and accepted with it, employer form + edit request (pending → approve) carry
  it, imported jobs untouched (11 checks; restart the server first — it spends 2 of the per-IP submissions). Rules:
  `docs/jobs-management.md` "Threshold condition". **Every application to a job with a condition goes through
  `thresholdRefusal`** (`models/schemas/thresholdCondition.ts`) before anything is claimed or stored.
- `BASE=http://localhost:3100 [DATABASE_URL=…] node test/e2e-employers.mjs` — employer accounts: the posting setting (open /
  account_required), employer sign-up by email code, own jobs only, edit request → pending → reject / approve / withdraw, claiming
  earlier submissions, employers refused on every staff/candidate route, imported jobs not editable (21 checks; restart the server
  first — it spends 4 of the per-IP submissions). Rules: `docs/employers.md`.
- `BASE=http://localhost:3100 [DATABASE_URL=…] node test/e2e-employer-isolation.mjs` — employer isolation: every staff/candidate
  route refused with nothing personal, IDOR, response shapes (no candidates, staff emails or other employers), edit-request
  allowlist, forwarded applicants only (name + CV), role transitions (no sign-up path turns an existing address into an
  employer; the staff role change takes staff ids only) (19 checks; restart the server first — it spends most of the per-IP write limit).
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-employer-applicants.mjs` — applicants forwarded to employers: not
  forwarded → invisible, other employer / imported → nothing, 90-day window (ages `job_inactive_since` in the DB), name + CV
  only, limits 429 + alert, strict log before data, cancel only before seen, deactivated employer, quick applications
  (22 checks; fresh DB; restart the server first). Rules: `docs/employers.md` "Applicants".
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-multi-role.mjs` — several roles per account: candidate →
  + employer (own account) → + content manager (admin); staff powers only on Google (a code session is candidate +
  employer only); staff views through the hand-over by email; employer sees only forwarded applicants, one employer
  budget per account on every session; removing staff keeps the rest; employer-only → + candidate; staff-only still
  Google-only; staff-only refused on apply (`candidate_role_needed`, nothing stored) → + candidate on the same Google session →
  applies; Google comes back to `/job/<id>`; a blocked candidate role → `role_blocked` (13 checks; fresh DB; restart the
  server first — it spends 1 of the per-IP submissions).
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-role-blocks.mjs` — blocking a role and employers editing every
  field (owner, 24.11.2026): admins only (others refused, bad input), find any account by email (roles + blocks only),
  a block closes every session and the person signs in again with the open roles (code / Google), a blocked role not
  added back, the staff role blocked → candidate only on Google, no self-block of staff, all blocked → no sign-in (neutral,
  logged), unblock, a blocked employer receives no forwards; the edit form carries every field, a staff-only added field
  write-only, invalid / board fields refused, nothing applied while pending, apply settings approved only by a content
  manager (coordinator 403), approval applies every field, empty staff-only answer = unchanged, back to the site default
  (13 checks; fresh DB; restart the server first — it spends 1 of the per-IP submissions).
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-review-fixes.mjs` — the privacy / security review of 24.11.2026:
  a 1MB "<<<…" answer refused at once (H1), a candidate + employer's added answers saved and required ones asked (M1),
  SMOOV (the suite's own mock, never a real one) gets a quick "yes" only for a never-removed address and every removal
  (M2), the dedicated list key, old-key rows still honoured and re-keyed at boot (M3), a failed webhook handled on
  Resend's retry (M4), the sandbox export without staff-only job answers (M5) (7 checks; server with SMOOV ON at the
  mock, `SANDBOX_EXPORT_TOKEN`, `RESEND_WEBHOOK_SECRET` — values in `run-local.mjs`; fresh DB).
- **Jobs imported from the existing site are read-only** (`jobs.imported_from_live`; 409 `job_read_only` + a DB trigger).
  Production has none since 17.11.2026 (one-time migration `2026-11-purge-imported-jobs`, owner's decision; launch.sh no
  longer imports); they exist only in local databases seeded with `importFromLive`.
  Never add a path that changes or deletes them: they live in the existing site and its Salesforce.
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-signup-fields.mjs` — sign-up fields setting (required / optional;
  ID number also hidden; content managers and admins on `/settings`, `/admin/settings/signup-fields`) enforced by the server on every sign-up and in the
  personal area; the Israeli ID number (check digit, clear, staff list only through `peopleHandover`, never in the log or
  to employers) (14 checks; fresh DB). **The ID number (`users.id_number`) is never on the default user object**
  (`rowToUser`); only `withIdNumber` / `findIdNumber` for the candidate's own view, the staff list and Salesforce.
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-settings.mjs` — the settings screen and added fields: content manager
  adds sign-up / job fields, public form definitions, required enforced on sign-up / personal area / new job, answers saved
  and shown (staff list through the hand-over, job page only when marked), never to employers, coordinators / employers /
  candidates refused, turned off ≠ deleted, the employer form + edit requests, public API / MCP `extraFields`, audit with
  ids only (16 checks; fresh DB; restart the server first — it spends 2 per-IP submissions).
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-salesforce-fields.mjs` — added fields → Salesforce against the MOCK
  org (same server setup as `e2e-salesforce.mjs`): only admins link, custom `__c` names only (never a field the site
  writes or the Beta mark), nothing sent until the org has the field (describe), then on the Contact / Position Case with
  Beta through the queue, unlink stops it, the connection check names unlinked fields (11 checks; fresh DB).
- `BASE=http://localhost:3100 node test/e2e-microsoft-sso.mjs` — "Continue with Microsoft" (candidates only) against the mock
  provider: PKCE/nonce/state, verified email only, staff refused (24 checks; needs the `MS_*` values from `server/.env.example`;
  restart the server first — sign-in suites share the per-IP limit). Setup and the email rule: `docs/microsoft-sso.md`.
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-salesforce.mjs` — Salesforce against a MOCK org (never a real one):
  connection check writes nothing, one Contact / Case per record (no duplicates on retries), the application CV once,
  imported jobs never pushed, employer → company Account + Contact, archive → `Closed`, Cases never auto-assigned, no
  backlog route, 503 → backoff retry, 400 → stops until an admin retries, expired session, strict log, Beta on every
  record, threshold condition fields (job text, application confirmation + time; missing → named by the check and
  skipped), admin-only screen, codes only (16 checks; server with Salesforce ON pointed at the mock — values in the suite's header
  and `server/.env.example`; fresh DB; restart the server first). Rules and the owner's guide: `docs/salesforce.md`.
- `cd server && npx tsc && node test/e2e-cutover.mjs` — the cutover from the existing site, self-contained (its own fresh
  pglite DB, mock Salesforce, mock of the existing site's public API, restarts the server between modes): its jobs read
  from Salesforce (`LEGACY_JOBS_MODE=mirror`: same `_id` / number, read-only, never pushed, incremental, closed off the
  board), candidates' existing Contacts adopted by verified email (never Beta, empty fields only, old `ID_cambium__c` in
  `A_CID_cambium__c`; guests never), `owned` → the SAME Position Case updated, `SALESFORCE_BETA_MARK=false`, rollback,
  the cutover report (28 checks). Rules: `docs/jobs-management.md` "Jobs of the existing site", `docs/salesforce.md` 1א.
- `cd server && npx tsc && node test/e2e-legacy-candidates.mjs` — the existing site's candidates, self-contained (own pglite DB,
  mock Salesforce): registered candidates of `LEGACY_CANDIDATE_ACCOUNTS` copied (`LEGACY_CANDIDATES_MODE=mirror`), quick
  applicants / other Accounts / Beta never; details view only (409 `candidate_read_only` on every change, DB trigger); they apply to jobs made here (their Contact on
  the Case, the CV linked) but nobody applies to the existing site's jobs (409 `job_on_existing_site`, DB trigger);
  the CV opened from Salesforce on demand through the hand-overs, never copied; `owned` → full writes to the SAME Contact,
  never Beta; rollback; deletion remembered (rules: `docs/salesforce.md` 1ב).
- **The existing site's candidates** (`users.legacy_state`): 'mirror' rows change only through the mirror
  (`services/legacyCandidates.ts`, `SET LOCAL skeelz.legacy_writer`; trigger `users_legacy_guard`); every write path refuses
  them (`assertCandidateEditable` / `CandidateReadOnlyError`); they are never queued for Salesforce until 'owned'. Their CV is a
  pointer `sf:<ContentVersion id>` opened by `services/legacyCvs.ts` — the ONLY Salesforce call on a request path (GET, one file).
- **The existing site's jobs** (`jobs.legacy_state`): 'mirror' rows change only through the mirror (`services/legacyJobs.ts`,
  `SET LOCAL skeelz.legacy_writer`; DB trigger `jobs_legacy_guard`), are never pushed and never deleted; 'owned' rows update
  their existing Case (never a new one, never Beta). A candidate's Contact is looked up by verified email before one is
  created (`salesforceService.upsertContact`); quick applications never are.
- **Salesforce goes through the queue** (`services/salesforceSync.ts` → `queueSalesforce(kind, id)`): never call
  `salesforceService` from a request path, never create a record without looking it up first, never delete in Salesforce, never send what happened while it was off (no backlog). Every Contact, Case and Account
  this site makes carries the Beta mark while `SALESFORCE_BETA_MARK` is on (`salesforceUtils.betaMark`; no Beta field →
  nothing is sent); the existing site's records it updates are never marked. Jobs stay on the
  existing Position record type and fields (no new job fields).
- `BASE=http://localhost:3100 node test/e2e-activity-log.mjs` — activity log: every sign-in / sign-up with address + device
  (staff included), every CV upload (`cv.uploaded` / `cv.attached`, ids only), unusual-sign-in alerts (`SIGNIN_ALERTS`), the
  admin-only per-person view (`GET /admin/audit/person`, strict `audit.person_viewed`) (12 checks; fresh DB; restart the
  server first). Every sign-in goes through `auditLogin` and a failure on a known account through `signinFailed`
  (`security/signins.ts`). Rules: `docs/security.md` "Sign-ins and unusual sign-ins".
- `BASE=… DATABASE_URL=… node test/live-security.mjs` — limit race, strict hand-over, append-only trigger, role from
  DB, revoked tokens, cross-site. Needs a **fresh** local database.
- `BASE=http://localhost:3100 node test/e2e-email-signin.mjs` — sign-in code by email: neutral answers, limits, tries,
  single use, sign-up form, staff refused, nothing personal in the log. Candidates sign in in every e2e suite through
  `test/helpers/candidate.mjs` (DEV_MODE-only `/api/dev/email-code`).
- Email goes out through **Resend** (`services/emailService.ts`, owner-approved 11.2026; setup `docs/email-signin.md`),
  only with `SEND_EMAIL_ENABLED=true` + `RESEND_API_KEY` + `EMAIL_FROM`; otherwise it only logs. Log ids/status/error
  codes only, never addresses, codes or Resend's response body. A new kind of email, or new data in one, needs a
  privacy-text update (Resend receives it). Candidates have no password (code by email or Google).
- **Every email goes through `sendMail(kind, to, values)`** (`server/src/mail`, owner 23.11.2026; `docs/mail.md`): the kind is
  in `mail/catalog.ts` (audience, closed parameter list, required parameters, default on/off, default text); content managers
  and admins turn events on/off and edit templates on `/mail-management` (versions kept, test send only to the editor).
  Never call `emailService.deliver` from a feature. Values are escaped and never read as markup (`mail/render.ts`); a new
  kind starts OFF unless it replaces an existing email; the sign-in code can't be turned off while email sign-in is on and
  falls back to the default text. Bounces / complaints come in through the signed webhook `POST /api/webhooks/resend`
  (`RESEND_WEBHOOK_SECRET`) and suppress the address (a keyed hash only). Service mail only: marketing mail, lists and
  unsubscribe are not built yet (phases 3–4 of `docs/mail-phases-3-4.md`).
- **The lasting address lists** (marketing removals, mail suppressions, unsubscribe links) use `security/addressKey.ts`
  with their own `MARKETING_OPTOUT_SECRET` (never rotated, never a JWT secret); the old derived key matches old rows only.
  Every push to a mailing list goes through `services/marketingList.ts mayPushToList` (a "yes" and not removed); every
  removal also calls `removeFromList`. Strip tags only with a linear pattern (`/<[^<>]*>/`) and check a text's type and
  length BEFORE any regex (security review 24.11.2026).
- **Marketing consent** (owner 23.11.2026; `docs/marketing-consent.md`, `security/marketing.ts`, `dal/marketingDAL.ts`): each
  candidate is agreed / not agreed / removed / unknown. A removal (`marketing_optouts`, keyed hash of the address; the
  personal area's "no", the signed one-click `POST /api/unsubscribe`, staff on request, a Resend complaint) ALWAYS wins;
  only the person's own signed-in "yes" clears it — never staff, never an unverified form (quick application, employer
  form). Every change writes `users` and `consent_records` in the same statement. Any future marketing send checks
  `mayReceiveMarketing` (agreed and not removed). Never shown to employers.
- `BASE=http://localhost:3100 DATABASE_URL=… RESET_TOKEN_SECRET=<the server's> node test/e2e-marketing.mjs` — marketing consent: sign-up yes /
  no, personal area, the unsubscribe link (neutral, signed), removal beats consent, staff remove but never opt in,
  coordinator read-only, employer refused, the list filter, ids only in the log (fresh DB; restart the server first).
- `BASE=http://localhost:3100 DATABASE_URL=… node test/e2e-mail.mjs` — the mail screen and events: gates, on/off (a turned-off
  event sends nothing), every event on every path (the staff invite also to an existing candidate / employer given a staff
  role, never on a staff role change; welcome also when the candidate role is added; employer emails also to an employer
  who is also staff) and the screen's counts, templates and versions, escaping, preview, test send only to the editor, the sign-in code locked
  and still sent with a broken template, the webhook signature (401 / 503), replay, suppression and its removal
  (server with `RESEND_WEBHOOK_SECRET` from the suite's header, email OFF; fresh DB; restart the server first).
