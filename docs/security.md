# Security — how candidates' data is protected (developer reference)

Reviewed 2026-11-11 with the app-security-baseline method. Public texts: `client/src/components/privacy/PrivacyPage.tsx`
(`/privacy`), including the database definition document and the security procedure (`privacyTexts.ts`, copied to
`docs/privacy/database-definition.md` and `docs/privacy/security-procedure.md` by `docs/privacy/build-docs.ts`).

## Roles
| Role (`users.role`) | Sees / does | Gate |
|---|---|---|
| `user` (candidate) | own details and applications | `signedIn` |
| `placement_coordinator` (רכז השמה, since 19.11.2026) | **views** candidates, applications, guest applications and CVs on `/users-management` (same hand-overs: daily limits, strict log, alerts; also the forwards list), and **manages jobs** on `/jobs-management`: create, edit, internal comments, pin / bump, status, publish date, sponsored, archive / restore, employer submissions and edit requests. **Never**: a threshold condition (set, change, clear, or approve a submission / edit request that carries one), a job's apply settings (guest mode, CV required), a site setting, a candidate's record (edit, CV unlink), a forward to an employer, a Salesforce push, API keys. Refused with 403 `content_manager_required` (field names only, logged as `access.denied`): `src/security/roleFields.ts` | `staffViewers` (gate `staffViewer`) |
| `content_manager` (מנהל תוכן) | everything a coordinator does, plus candidates' records (edit, CV remove from a profile — the file is kept), forwards to employers, Salesforce pushes, threshold conditions, apply settings, and the job/candidate settings: sign-up fields, apply policy, employer posting — candidates through `peopleHandover` / `cvHandover`, within the daily limits | `staffViewers` + `contentManagerOnly` |
| `admin` (מנהל מערכת) | **everything a content manager does** (same hand-overs: daily limits, strict log, alerts), plus `/security-management` (alerts, usage, grants, access reviews, activity log, API keys) and `/staff-management` (staff users) | `staffViewers` (`VIEWER_ROLES`), `contentManagerOnly` (= content manager + admin, `CONTENT_ROLES` in `src/models/enums.ts`) and `adminOnly` |
| admins only (owner, 20.11.2026) | internal API tokens: list all, revoke any, create any scope (not content managers or coordinators) | `adminOnly` |
| `employer` (מעסיק, since 11.2026) | own details, own job submissions, own published jobs, edit requests for them (pending until a coordinator or content manager approves; a threshold condition only a content manager); of candidates **only** the name + CV of applications a content manager forwarded to them, for their own jobs, until 90 days after the job closed (own budgets, strict log; "Applicants" in `docs/employers.md`) — never other candidates, emails, phones, applications, counts or staff screens. Signs in like a candidate (Google, Microsoft, code by email). Rules: `docs/employers.md` | `employerOnly` (the only gate that admits an employer; `signedIn` is candidates + staff) |

Since 12.11.2026 (owner's decision) an admin is also a content manager; a content manager stays content-only. The
gate decides it in one place (`contentManagerOnly` admits `CONTENT_ROLES`); controllers that check the role use
`canManageContent`. An admin's candidate views are counted in their own daily budget and logged with their email.
Since 19.11.2026 (owner's decision) a placement coordinator sees what a content manager sees and manages jobs, but
changes no candidate and no setting: the gate `staffViewers` (`VIEWER_ROLES`) admits coordinators, content managers
and admins; controllers that only show use `canViewStaffData`, the field checks use `canManageContent`. A coordinator
is staff: SSO only, access-reviewed, logged by email, own daily budgets (same numbers), grants by an admin.

**Several roles per account** (owner, 23.11.2026, replacing "one role per account": "a user can be a candidate, an
employer and a content manager / admin at once; everyone can do everything and such overlaps may exist"). `users.roles`
is the set and the source of truth; `users.role` is derived by a DB trigger (`users_roles_sync`: the highest role,
admin > content_manager > placement_coordinator > employer > user), so code that names a person by their highest role
(the log actor, the staff lists) keeps working; a write of `users.role` alone keeps its old meaning (that is the only
role). At most one staff role per account (`users_roles_check`). Each role keeps its own rules:
- **Gates** open when ANY role of the session is allowed (`jwtAuthMiddleware`); the roles come from the DB on every request.
- **Staff roles count only on a Google (xhostd SSO) session** (`security/pure.ts effectiveRoles`). A candidate who is also a
  content manager and signs in by an emailed code or with Microsoft is a candidate (and employer) on that session; the
  staff routes refuse it. A staff-only account still signs in only with Google (no code, no Microsoft).
- **Hand-overs and limits are per role, unchanged.** As staff, the person sees candidates only through
  `peopleHandover` / `cvHandover` (strict log, their staff budget, by email). As employer, only applicants forwarded to
  their own jobs (name + CV), on ONE employer budget owned by the account (`budget_owner = user:<id>`, whatever the
  session; `employerApplicantsController`), separate from the staff budget. Their own candidate data is handled as any
  candidate's (others see it only through the hand-overs).
- **Adding a role:** the staff role only by an admin (staff screen, below). The candidate and employer roles by the person,
  from inside their account (`POST /api/users/me/roles/candidate | employer`, gate `anyAccount`, used nowhere else):
  the usual form and consent (a `consent_records` row in the same statement, source `candidate_role_added` /
  `employer_role_added`), logged `auth.role_added` (the role only). No route adds a staff role to oneself.
- **Every signed-in person is a candidate** (owner, 24.11.2026: "מבחינתי כל אדם מחובר הוא מועמד"). Decided: the
  candidate role is NOT added silently at sign-in (it brings new data — details, CV, applications — and the candidate's
  consent). It is added when the person applies: an account without it (an employer only, a staff member on Google)
  pressing "הגש מועמדות" gets the candidate details step INSIDE the apply dialog (`jobcard/CandidateStep.tsx`: the
  sign-up form with the sign-up fields setting and the added questions, prefilled from the account, and the consent
  boxes → `POST /users/me/roles/candidate`, same checks, `consent_records` row, `auth.role_added`), then goes straight on
  to the CV dialog. `/join/candidate` stays for doing it without a job.
- **Only the candidate role applies** (`POST /jobs/apply/:jobId`): the gate `signedIn` also admits staff, so the handler
  refuses a session without a usable candidate role first, before anything is read or stored: 403 `candidate_role_needed`
  (`access.denied`, reason `candidate_role_needed`), or `role_blocked` when an admin blocked it. This refusal does not
  sign the person out (it is not a gate), so the dialog goes on with the candidate step on the same session.
- A blocked candidate role: the apply dialog says so in place (`BlockedCandidateNote`, from `user.blockedRoles` of the
  person's own session), never offers the candidate step, and the server refuses both the application and the role.
- A **legacy mirror** candidate (read-only until the cutover) may get other roles; it must keep the candidate role
  (`users_legacy_guard`).
- Deactivation stays per account (all its roles). To stop ONE role, block it (below).

**Blocking a role** (owner, 24.11.2026: "an admin blocks each of the three roles of a specific user, one by one — e.g.
keep someone as a candidate but block them as an employer"; `src/controllers/roleBlocksController.ts`, admins only).
`users.blocked_roles` holds the blocked kinds: `user` (the candidate role), `employer`, `staff` (whichever staff role the
account holds; DB check `users_blocked_roles_check`). A blocked role **stays in `users.roles`** (its data stays: the
candidate's record, the employer's jobs) but counts for nothing: every place that decides what a person may do uses
`usableRolesOf` (`models/enums.ts`) = the roles minus the blocked ones, then `effectiveRoles` for the sign-in method:
- **Gates** (`jwtAuthMiddleware`, read from the DB on every request) never open on a blocked role.
- **Every sign-in path** (Google, Microsoft, code by email; sign-up into an existing account included) goes through
  `authService.issueSession`, which refuses when no role of that session would be left (`au19` `ROLES_BLOCKED`;
  `auth.login_refused_blocked`, for codes `auth.email_code_refused_blocked` — no code is sent, the answer stays the neutral
  one). Otherwise the session carries only the open roles.
- **A block closes every session at once** (`sessions_revoked_at` + refresh tokens + the internal API keys the person
  issued, `issuer_role_blocked`), like a role change. The person signs in again and gets the roles still open; with none
  left, no sign-in works. Removing the staff role (staff screen) does the same (unchanged).
- The person can't add a blocked role back (`POST /users/me/roles/candidate | employer` → 403 `role_blocked`); a role
  the account doesn't hold yet may be blocked in advance. Only an admin unblocks (unblocking closes nothing).
- A blocked employer receives no forwards (`employer_inactive`, as a deactivated one) and sees nothing (the gate).
- Lock-out: an admin can't block their own staff role (`self_staff`) nor that of the last admin who can act
  (`last_admin`; `activeAdmins` doesn't count admins whose staff role is blocked). Changes run one at a time with the
  staff screen's.
- Where: `/staff-management` (per staff member, and "חסימת תפקיד בחשבון": find ANY account by email — employers are on no
  list) and `/users-management` (per candidate, admins only). `GET /api/admin/role-blocks?email=` / `GET …/:userId` return
  the account id, the kinds of role it holds and the blocks — nothing else about the person. `PUT
  /api/admin/role-blocks/:userId/:role { blocked }`. Logged `users.role_blocked` / `users.role_unblocked` (target the
  account id; role, roles, before / after, `sessions_closed`) and `users.role_blocks_viewed`.

Staff users (`src/controllers/staffController.ts`,
`/api/admin/staff`): add by email (an existing account — a candidate, an employer — gets the staff role ADDED and keeps
its other roles; a new one is created **without a password** (staff sign in only with Google) — the admin never sets or
sees passwords), change the staff role (`user` = remove staff access: the other roles stay; an account left with none
becomes a candidate, as before; a promoted account's password is cleared; logged with `roles_before` / `roles_after`), deactivate
(`users.deactivated_at`: no login, no session), reactivate, revoke sessions (`users.sessions_revoked_at`: refresh tokens
disabled **and** access tokens issued up to that second refused). Deactivate, change role and revoke sessions also
revoke every internal API key the person issued (`api_token.revoked`, `reason`: `issuer_deactivated` /
`issuer_role_changed` / `issuer_sessions_revoked`). Lock-out (`staffChangeRefusal`, `src/security/pure.ts`):
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
| Candidates (`users`, role `user`) | xhostd Postgres | the candidate (own row, via login); coordinators (view), content managers |
| Staff (`users`, role `content_manager` / `admin`) | Postgres | admins (staff users screen: email, name, role, state, last login) |
| Applications (`job_applications`) | Postgres | the candidate (own); coordinators and content managers (counted + logged) |
| CV files | xhostd blob (`post-scan/<token>/<name>`) | coordinators and content managers, via `GET /api/files/:userId` (counted + logged) |
| Job internal comments | Postgres `jobs.comments` | coordinators and content managers |
| Activity log (`audit_log`) | Postgres, append-only trigger | admins, `/security-management` |
| Security alerts (`security_alerts`) | Postgres | admins (red banner + screen); raised by content managers' usage and by unusual sign-ins (address of the sign-in in the alert) |
| Guest (quick) applications (`guest_applications`: name, email, phone, job, CV key; consent in `guest_consents`, same guest id) | Postgres, **never deleted** (trigger refuses DELETE / TRUNCATE); CV in the blob | content managers and admins, `/users-management` → `GET /api/admin/guest-applications` (`peopleHandover`), CV `GET /api/admin/guest-applications/:id/cv` (`cvHandover`); Salesforce when on (`salesforce_sent_at`; unsent ones pushed by staff: `POST /api/admin/guest-applications/salesforce-push`, 409 while off) |
| Employer job submissions (`job_submissions`): the job + the employer's contact name, email, phone | Postgres, kept 12 months after review (`SUBMISSION_RETENTION_MONTHS`) | content managers only (`contentGate` = `contentManagerOnly`), contact details only when one is opened (logged); the employer account that sent or claimed it (`submitted_by_user_id`): its own list, without contact details |
| Employer accounts (`users` role `employer` + `employer_profiles`: name, email, company, phone, job title) | Postgres | the employer (own, `/api/employer/me`); content managers see name and company on an edit request; Salesforce Contact when on (`salesforce_sync` kind `employer`) |
| Employers' jobs and edit requests (`employer_jobs`, `job_edit_requests`: job fields only) | Postgres; reviewed/withdrawn requests kept 12 months | the employer (own; the reviewer is shown only as `staff` / `self`, never the staff email stored in `reviewed_by`); content managers (queue on "משרות ממעסיקים") |
| Forwards to employers (`employer_forwards`: kind, application id, candidate id, job, employer, who/when forwarded, `first_seen_at`, cancel) and `job_inactive_since` (when a job stopped being active) | Postgres; forwards **never deleted** (trigger: no DELETE/TRUNCATE, identity columns fixed, no cancel after `first_seen_at`, a cancel is final) | content managers and admins (`GET /api/admin/employer-forwards`, `peopleHandover`); the employer: name + forward date + CV of their own live forwards inside the window (`GET /api/employer/applicants`, `peopleHandover` budget `employerPeople`; CV `GET /api/employer/applicants/:forwardId/cv`, `cvHandover` budget `employerCvs`) |
| Internal API tokens (`api_tokens`) | Postgres: SHA-256 hash + prefix, never the token; `created_by_user_id` = the issuer | admins only (metadata, create, revoke) |
| Salesforce sync state and queue (`salesforce_sync`) | Postgres: record id, Salesforce Id(s), times, error code, the CV key already sent | internal API (`salesforce:push`); admins see ids and codes on the security screen |

## Gates (every entry point)
- `signedIn` / `staffViewers` / `contentManagerOnly` / `adminOnly` (built by `authenticateAndAuthorizeWithJWT(roles, tag)`) and
  `tryExtractTokenPayloadMiddleware` (`src/middleware/jwtAuthMiddleware.ts`): access token, else a refresh token
  **checked against the DB**; then the user is loaded and the **DB role** is used; deactivated accounts and access
  tokens older than `sessions_revoked_at` are refused. New routes import the gates from there.
- `test/gates.test.mjs` walks the router and fails when a route has no gate and isn't on its public list, when a
  candidate-view / jobs-management route isn't exactly `staffViewers` or a settings / candidate-record / forward route
  isn't exactly `contentManagerOnly` (both lists are complete: a new route must be placed on one), or when an `/admin/security|audit|staff` route
  isn't exactly `adminOnly` (and no other route may be admin-gated), or when an `/employer` route isn't exactly
  `employerOnly` (and no other gate may admit the `employer` role).
- Public routes: the read-only public API and MCP server (below), health, logout, sign-in code by email (request, verify, sign-up form), job lists/one job, skills, locations, guest apply,
  anonymous CV upload + cancel of one's own pending upload, the token-protected sandbox export, the employer job form
  (`POST /job-submissions`: 5/hour per IP, honeypot, at most 300 pending, field caps, server-side validation, plain text only).
- Employer submission review (`/admin/job-submissions/*`) and employers' edit requests (`/admin/job-edit-requests/*`) sit
  behind `contentGate` in `routes.ts`, which is `staffViewers` (a coordinator approves, except a threshold condition or
  a job's apply settings: 403 `content_manager_required`; `CONTENT_MANAGER_FIELDS`). Since 24.11.2026 an employer may ask
  to change every field of their job (`docs/employers.md` "Edit requests"), nothing applied before staff approve. The settings (`/admin/settings/apply-policy` PUT, `/admin/settings/employer-posting`,
  `/admin/settings/signup-fields`, `/admin/settings/custom-fields`) are content-manager-only — all on the settings screen
  `/settings` (`docs/settings.md`); the job form's added-field definitions (`GET /admin/job-fields`) are `staffViewers`; reading the apply-policy defaults is `staffViewers` (the
  jobs table shows them). With employer posting
  `account_required` the public form refuses anyone but a signed-in employer (DB role; `docs/employers.md`).
- Employers' own routes (`/api/employer/*`) check ownership first: a job or request that is not theirs is 404 / 409
  whatever it is (archived, imported, someone else's), so ids can't be probed. Isolation is tested end to end in
  `test/e2e-employer-isolation.mjs` (every staff/candidate route refused with nothing personal in the answer, IDOR by
  ids in paths and bodies, response shapes scanned for candidate, staff and other employers' data, edit-request field
  allowlist and safe HTML, role transitions, the DB role on an old token). An employer sees candidate data only as the
  applicants staff forwarded to them: name + CV, nothing about an application before it is forwarded (not even a
  count). Tested in `test/e2e-employer-applicants.mjs` (window, other employers, imported jobs, shapes, limits, log
  before data, cancel rules, deactivation, guest applications).
- A submission is never in `jobs` until approved, so no public query (board, job page, page data, Salesforce) can see
  it. Approval creates the job through `jobsService.createJob` (Salesforce only then, when on). The description is plain
  text, escaped and sanitized at approval; the review screen shows it as text.

## Sign-in (who signs in how)
One rule, in `src/security/pure.ts` (`STAFF_ROLES` = `REVIEWED_ROLES`, `isStaffRole`, `methodAllowedForRole`):
**staff (admin, content manager, placement coordinator) sign in only with xhostd SSO; candidates with the same SSO, "Continue with Microsoft"
or a one-time code sent by email. Nobody has a password** (removed 11.2026; candidates' stored hashes cleared by the
migration `2026-11-clear-candidate-passwords`, `migrateClearCandidatePasswords` in `src/config/db.ts`; no account,
application or CV was touched).
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
- **"Continue with Microsoft"** (`/api/auth/microsoft/start|callback`, `controllers/microsoftSsoController.ts`,
  `security/microsoft.ts`; setup in `docs/microsoft-sso.md`) — **candidates only**, off unless `ENABLE_MICROSOFT_SSO=true` with
  `MS_CLIENT_ID` and `MS_CLIENT_SECRET`. xhostd's own sign-in is Google only, so this is our own OIDC client at
  `login.microsoftonline.com/common/v2.0` (personal and work/school accounts): authorization code + PKCE S256, scopes
  `openid email profile`; state, nonce, verifier and redirect URI in a signed httpOnly 10-minute cookie (`oidc_microsoft`,
  SameSite=Lax, path `/api/auth`); the code is exchanged server to server with the secret; the ID token is checked against
  Microsoft's JWKS (RS256 only), issuer `https://login.microsoftonline.com/<tid>/v2.0` of the token's own tenant (the tid
  only picks the one issuer we then require), `aud` = our client id, expiry, nonce. The access token is discarded (no Graph
  calls). **Verified email only:** personal accounts (tid `9188040d-…`) → the `email` claim; work/school accounts → the
  `email` claim only with `xms_edov: true` (email domain owner verified), else refused (`ms_unverified_email`);
  `preferred_username` / `upn` are never used (any tenant admin can set them). Key `users.ms_sub` = `<tid>:<sub>`. Mapping:
  stored key → that candidate; else a candidate with that email → linked (`auth.sso_linked`, password cleared as with Google);
  **a staff-only email or account → refused (`staff_google_only`), never linked** (an account that is staff AND a
  candidate / employer is linked and signed in as that candidate / employer only); else the same sign-up form (the
  `sso_signup` cookie carries `pv: microsoft`, so the new candidate is linked to `ms_sub`). Sessions carry
  `via: 'microsoft'`, which never counts for a staff role.
- A candidate without a phone or a town (an account an earlier SSO sign-in created bare) is asked to complete them after
  signing in (`/auth/session` → `profileIncomplete`; the same form, saved through `PATCH /users/me`).
- **Code by email ("קבלת קוד למייל")**, candidates only (`src/controllers/emailSigninController.ts`, pure part
  `src/security/emailCode.ts`, owner steps `docs/email-signin.md`). `POST /api/auth/email/request {email}` answers the
  same 200 text for every address, **before** anything about the account is decided, so neither the text nor the time
  says whether it exists. A 6-digit code (CSPRNG) goes to a new address (that is the sign-up) or to an account holding a
  candidate or employer role (that session never carries a staff role); staff-only and deactivated accounts get nothing, but a row with a code nobody knows is stored, so wrong codes, tries and limits
  behave the same. Stored in `email_codes`: an HMAC of the address (never the address), an HMAC of the code bound to
  the address (never the code), expiry 10 min, tries, used; a new code kills older ones; rows are deleted after 24 h.
  Feature switch `EMAIL_CODE_SIGNIN_ENABLED` (`emailCodeEnabled`, off unless exactly `true`): off → all four routes and
  the dev routes answer 503 `au18`, `/auth/providers` says `emailCode: false` and the client shows the option greyed out.
  `POST /api/auth/email/verify {email, code}`: each try is counted in the DB before the comparison (atomic, so
  parallel guesses can't exceed 5), constant-time compare, single use (`used_at` set by one request only). Right code →
  a candidate with that email is signed in (`via: email_code`); no account → a signed httpOnly 20-minute cookie
  `email_signup` (SameSite=Strict, path `/api/auth`) and the sign-up form (`GET|POST /api/auth/email/signup`: same
  `checkProfile` and `checkConsent` as every sign-up, email only from the cookie, role always `user`). Limits: per IP
  20 requests / 60 verifies per 15 min (`routes.ts`), per address 60 s between codes, 5 an hour, 10 a day (429 `au14`,
  the same for every address). Development only (`DEV_MODE=true`, never with `NODE_ENV=production`):
  `GET|POST /api/dev/email-code` read / mint a code for the e2e scripts (`devRouter`, mounted by `index.ts`).
- Staff invites (staff screen) email a "sign in with Google" note, never a password.
- Every request: the session's `via` (in the access and refresh tokens) is checked against the user's role **from the DB
  now** — a non-SSO session (code by email, or an old password one) of someone who is (or has since become) staff counts as no session.
- The callback is the only `/api` path the cross-site refusal lets through, and only as a top-level GET navigation.

## Personal area (a candidate's own details)
`GET|PATCH /api/users/me`, `DELETE /api/users/me/cv` (`signedIn`, writes rate-limited): the record is always the
caller's own (id from the session — no id in the path or body is read) and only a candidate's (`role = 'user'`; staff get
403). Fields: the allowlist `PROFILE_FIELDS` (name, phone, town, gender, birth date, skills, profile CV), checked with the
sign-up rules; an empty value never clears a required one; a phone used by another account is refused (`us3`). Email is
read-only for everyone (it is the sign-in name, and the Google identity for SSO accounts; changing it would need a new
code to the new address, not built). Role can't be set here; there is no password. A new CV must be an unclaimed
upload and becomes this user's (`claimCvUpload`); removing it clears the profile CV, the file stays for past applications.
Logged as `user.profile_updated` (target `self`, field names only).

**Sign-up fields setting** (`app_settings.signupFields`, `security/pure.ts` `SIGNUP_FIELDS`): a content manager or admin chooses, on
the settings screen `/settings` ("שדות בטופס ההרשמה", `GET|PUT /api/admin/settings/signup-fields`, `contentManagerOnly` — moved from the admin security screen on 19.11.2026 and from the candidates screen to `/settings` on 23.11.2026; logged as
`settings.signup_fields_updated`), whether phone, town, gender, birth date and ID number are required or optional (the
ID number also "hidden": not asked). First and last name are always required. Default = the form as before (all
required) with the ID number optional. The form reads it from `GET /api/auth/signup-fields` (public: the setting only);
the **server enforces it** in `checkProfile` on every sign-up (Google, Microsoft, email code) and in `PATCH /users/me`,
so skipping a required field in the browser is refused (400 with the field names). `profileIncomplete` follows it for
phone and town.

**Added sign-up questions** (`custom_fields` form `signup`, answers `users.custom_fields`; `docs/settings.md`): content
managers add them on `/settings`. Like the ID number, the answers are never on the default user object (`rowToUser`): only
the candidate's own view (`GET /users/me`) and the staff candidates list (`GET /api/users`, through `peopleHandover`).
Never to employers, Salesforce, analytics or a log (ids only: `customFields.<id>`). Required ones are enforced by the
server on every sign-up and in `PATCH /users/me`.

**ID number (תעודת זהות)** — `users.id_number`, sensitive:
- Checked by the check digit (`normalizeIsraeliId`; 5–9 digits, stored as 9). Optional unless the setting requires it;
  in the personal area an empty value clears it (unless required).
- **Never on the default user object** (`rowToUser` doesn't read it). Only `withIdNumber` / `findIdNumber`, used in
  exactly three places: the candidate's own `GET /users/me`, the staff candidates list `GET /api/users` (through
  `peopleHandover`: limit + strict log), and the Salesforce Contact (`ID_Number__c`, only when the org has the field).
  Employers never get it (their applicant view is name + CV only); the public API, MCP and internal API don't select it.
- Never in `details` of the activity log (field names only: `user.profile_updated` lists `idNumber` as a name), never in
  analytics (the client sends no field values), never in console output (`redactText` masks 8–9-digit runs as `[id]`),
  never in an email (Resend gets nothing new).

`PUT /api/users/me/marketing-consent` `{ marketingConsent: boolean }` gives or withdraws marketing consent, logged as
`user.marketing_consent_changed`. "No" there puts the address on the removal list; "yes" (the person's own) clears it.
The removal list, the four states and who may change what: `docs/marketing-consent.md`.

## Consent (`src/security/consent.ts`)
Every form that collects personal data has two boxes, sent as two fields and checked on the server:
- `consent` — **required**, only the literal `true`: the terms of use and the privacy policy (`/privacy#terms`), which
  cover keeping and using the data to run the service, passing it to employers about the jobs applied to, and to
  service providers and third parties under agreements signed with the nonprofit.
- `marketingConsent` — **optional**, unticked: marketing mail and updates about cooperations. Separate because
  marketing consent must be explicit and freely given (Communications Law s. 30A). `MARKETING_REQUIRED` makes it a
  condition — the owner's call; take legal advice first.

Stored per record: `users` / `job_submissions` (`terms_version`, `terms_accepted_at`/`consent_at`,
`marketing_consent`, `marketing_consent_at`) and, since a guest application leaves no user row, `guest_consents`
(guest id, job id, email, the same fields). Forms: sign-up after a code by email (`POST /api/auth/email/signup`, 400 `terms_required`), SSO sign-up
(`POST /api/auth/xhostd/signup`), guest apply (`POST /api/jobs/guestApply`), employer form (`POST /api/job-submissions`,
`fields.consent`). A registered candidate who never accepted the current `TERMS_VERSION`, or never answered the
marketing question, gets 428 `consent_needed` `{ needTerms, needMarketing }` from `POST /api/jobs/apply/:jobId`; the
client asks once and resends. That check runs only after the job, duplicate, threshold and CV rules passed, and the
answers are stored only then: a refused application stores no consent, and a missing CV is reported first.
**Nothing is asked on entering the site (owner, 27.11.2026).** Visitors see only the small notice at the bottom
(`NoticeBanner`: what is collected and the measurement, one "הבנתי" button, no choice to make). Consent is asked only in
an interaction: signing up (the sign-up form) or applying (the candidate step / the apply dialog) — two boxes, the terms
required and the marketing mail optional and unticked. A signed-in candidate who accepted the current `TERMS_VERSION` is
never asked again; after a bump (or a candidate copied from the existing site) they are asked when they next apply (428
above). `PUT /api/users/me/terms` (source `first_signin`, logged as `user.terms_accepted`) stays for that same answer
outside an application; the client no longer opens a dialog for it at sign-in.
One quick application per address
and job: a second one gets the same answer as a new one and nothing is stored or mailed (review 24.11.2026, L6).
Bump `TERMS_VERSION` when the terms change in a way that needs a new agreement.

**Versions and the acceptance log (owner, 19.11.2026).** Every version of the privacy policy + terms has an id
(`TERMS_VERSION` = `PRIVACY_VERSION` in `privacyTexts.ts`, shown on `/privacy`) and is kept as published:
`server/privacy-versions/<id>.html` (the page rendered by `cd client && npm run snapshot:privacy`), added to
`privacy_versions` on every migrate and never changed (trigger). Every acceptance — and every marketing answer — is a
row in `consent_records` (`at`, `subject_kind` user / guest / job_submission, `subject_id`, `privacy_version` FK,
`marketing`, `source` signup / employer_signup / apply / personal_area / guest_apply / job_form), written in the same
statement (or transaction) as the record it belongs to; append-only (no UPDATE, DELETE or TRUNCATE). The columns on
`users` / `guest_consents` / `job_submissions` keep only the latest answer. Versions before 2026-11-19 were not kept
(nobody had really accepted them). **Changing any text on `/privacy` needs a new version:** bump both ids, run the
snapshot; `npm test` fails while the page differs from the stored file.
**Only `marketing_consent = true` ever reaches the mailing list** (`mayAddToMailingList`, the only gate before any
SMOOV call; a test fails if another caller appears). Withdrawal stops future pushes; if SMOOV is turned on, also remove
the address there (not automated yet). Guests withdraw through the contact page.
Notice banner (`NoticeBanner.tsx`): every visitor, asks nothing, dismissal in `localStorage` (`skeelz_notice_v1`);
when analytics is on, the cookie-consent banner carries the same notice instead.
- Off unless `SSO_ENABLED=true` (then staff can't sign in at all; the server warns at boot). Issuer/JWKS overrides
  for the mock provider in tests are honoured only with `DEV_MODE=true`.

## Public API and MCP server (`src/public/`)
Unauthenticated, read-only: `GET /api/public/v1/{jobs, jobs/near, jobs/:id, locations, skills, openapi.json}` (+ a docs
page at `/api/public/v1/`) and an MCP server at `POST /mcp` (Streamable HTTP, stateless) with five tools —
`search_jobs`, `get_job`, `jobs_near`, `list_locations`, `list_skills` — all `readOnlyHint: true`, no resources/prompts.
Both call `publicService.ts` only. What protects it:
- **One allowlist serializer:** `toPublicJob` / `toPublicLocation` / `toPublicSkill` (`publicJob.ts`) copy fields by
  name. Out on purpose: internal comments, the apply-policy overrides and CV rules (only the effective `applyMode`
  goes out), `uploadBy`, `isMarked`, status, timestamps, anything Salesforce. The contact person's name/phone/email
  go out as `applyContact` **only on a self-apply job** (where the job page shows them to anyone; `null` otherwise);
  the site's own lists never carry them, and its one-job answer only on a self-apply job (`jobDAL.rowToJob`). A new DB column cannot leak. `test/public.test.mjs` and `test/e2e.mjs` pin the exact key sets.
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
- **Who issues what:** token routes are `adminOnly` (owner, 20.11.2026: keys are a security matter, so they live only
  on the admin security screen, not on jobs management). Admins list every token's metadata and can revoke any token.
  Creating: the handler also checks the **DB role** (`req.authUser.role`) against `issuableScopes`
  (`src/internalApi/pure.ts`): every scope for an admin, none for anyone else; a key whose issuer is no longer an
  admin is refused on use (`token_issuer_role`). Anyone else asking gets 403 `scope_not_issuable`, logged as `access.denied` (`api_token:scope_not_issuable:…`). `salesforce:push` is not a people scope: it sends
  records to Salesforce (logged as `salesforce.pushed`) and returns to the caller only record ids, Salesforce ids and
  status/error codes — never names, contact details or files. The content manager sees the screen on
  `/jobs-management`, the admin on `/security-management` too; each is offered only what it may issue.
- **Tokens:** created by a staff member (name, scopes, expiry 1–90 days, default 30). Format
  `skzi_<8 hex>_<43 base64url>` (256-bit random part). Only `sha256(token)` and the prefix are stored; the token is
  shown once. Revoke = effective on the next request. `last_used_at` updated at most once a minute.
  Actor in the log: `token:<prefix>`. **The issuer stands behind the key** (`api_tokens.created_by_user_id`, backfilled
  from `created_by`): on every use the key is refused (401 `token_issuer_inactive` / `token_issuer_role` /
  `token_issuer_unknown`) when the issuer is deactivated, missing, or their DB role no longer allows every scope on it
  (`issuerRefusal`, `issuableScopes`); the staff screen also revokes their keys (above).
- **Server secret:** `INTERNAL_API_SECRET` (xhostd secret, ≥ 32 chars, else off), compared in constant time
  (`timingSafeEqual` of SHA-256 digests). All scopes. Actor: `system:internal-api`.
- **Scopes:** `jobs:read`, `jobs:write`, `candidates:read`, `applications:read`, `cvs:read`, `salesforce:push`.
  CV files need `cvs:read` plus `candidates:read` / `applications:read`.
- **Refusals:** no/unknown token 401, expired/revoked 401 (`token_expired` / `token_revoked`), missing scope 403;
  all logged as `access.denied` (reason `internal_api:…`, throttled). Cookies are never read; the cross-site refusal
  on `/api` applies; 300 requests/minute per IP.
- **People data:** candidates/applications through `peopleHandover`, CVs through `cvHandover`, with the token (or the
  secret) as `who` (the actor in the log). A key's daily limits, alerts and grants are **its issuer's**
  (`budgetOwner`; entries carry `details.budget_owner`), so one person's keys and screens share one allowance; the
  secret has its own. The `candidates.shown` filters record `search: true`, never the text. The answers never contain passwords or storage keys (CV = a link to the CV endpoint).
- **Salesforce push:** 409 `salesforce_disabled` while Salesforce is off (route check + the service refuses
  too). Idempotent: Salesforce Id from `salesforce_sync`, else looked up by the job / candidate / application id
  field on the Case or Contact (field names in `server/src/utils/salesforceUtils.ts`); update, or create if missing. An application pushes its candidate first and attaches its CV
  once (`synced_cv_key`). `salesforce.pushed` (strict, candidate ids) is written before the first outbound call;
  the outcome is stored per record as a code (`http_400_REQUIRED_FIELD_MISSING`, `auth_invalid_client`, `not_found`, …), never a body.

### Salesforce sync (docs/salesforce.md)
- **On** only with `ENABLE_SALESFORCE=true` AND every setting valid (`server/src/config/salesforceSettings.ts`); the
  boot log and the admin screen name what is missing, never a value. `SANDBOX=true` forces it off. Off → nothing is
  queued and nothing leaves the server.
- **Queue, not inline:** a change on the site only queues the record (`services/salesforceSync.ts`, `salesforce_sync`
  rows with `queued_at`); a worker sends it (a strict `salesforce.pushed` with the people's ids first, actor
  `system:salesforce-sync`). Requests never wait for Salesforce or fail because of it. Retries with growing waits
  (1 min … 24 h, 8 times); HTTP 400 and records that must not be pushed stop at once. No duplicates: every record is
  found by its id field first.
- **Beta (owner's rule):** every Contact, Case and Account written carries `Beta__c = true` (`SALESFORCE_BETA_FIELD`),
  so the team's current lists and automations leave them out. Without a writable Beta checkbox nothing is sent
  (`beta_field_missing`); the connection check verifies it on all three objects.
- **Owner:** what the site creates belongs to the integration user; every Case write sends `Sforce-Auto-Assign: FALSE`
  (assignment rules don't move it). Employers' Accounts / Contacts are found only by `SKEELZ_Employer_Id__c`, so an
  Account the team made is never touched.
- **No backlog (owner's rule):** what happened while it was off is never sent; there is no route for it.
- **Never pushed:** jobs imported from the existing site (the queue refuses them; the push refuses them again).
  Nothing is ever deleted in Salesforce. Staff and employers are never sent as candidates (the queue checks the role).
- **Sign-in:** Client Credentials against My Domain only, secret in the POST body, token renewed every 30 minutes
  (the old one revoked), one retry on 401. Errors are reduced to the OAuth error code.
- **Admins** (`/admin/security/salesforce*`, `adminOnly`): state (ids, codes, counts; the client id and the secret are
  never shown), a READ-ONLY connection check (`salesforce.checked`), retry failures (`salesforce.retried`). `npm run sf:check` runs the same check from a shell.

## Hand-overs (strict log, limits)
`src/security/handover.ts`: `peopleHandover` (candidate lists, someone's applications) and `cvHandover` (CV open).
Order: lock → usage from the log → refuse at the limit (429 + alert) → load → **strict** entry with the ids shown →
send. If the entry can't be written: 503 and nothing is sent. Limits (`src/security/pure.ts` `LIMITS`):
CVs 40/day (alert 20, grant +40); candidates shown 1,500/day (alert 750, grant +1,500), each candidate once a day.
The limits apply to placement coordinators, content managers and admins; alerts go to admins, and only an admin can grant more
(`POST /api/admin/security/grant` accepts active coordinators / content managers / admins and the staff budgets only).
**Employers** have their own budgets (`employerPeople` 200/day, alert 100; `employerCvs` 30/day, alert 15; no grants)
and their own actions (`employer.applicants_shown`, `employer.cv_opened`), counted per employer (`user:<id>`), alerts
to admins like staff (`employerPeople_many` / `_limit`, `employerCvs_many` / `_limit`); the security screen shows
"מעסיקים היום". A forward counts as seen by the employer (no longer cancellable) only after the strict entry was
written: a refused log leaves it unseen. Bypass attempts on forwards (IDOR, identical 404s, CV headers, one owner per
job, claim, every staff path that changes a job's state, forged forwards) are in `test/e2e-employer-applicants.mjs`.
The lock is in-process (one Node process); switch to `pg_advisory_xact_lock` if the app ever runs as several processes.

## Sign-ins and unusual sign-ins (`src/security/signins.ts`)
Every successful sign-in, every method and every role (staff included), writes `auth.login` with the role, the method,
the address (`ip`, from the edge proxy: `trust proxy` 1) and a device summary (`deviceSummary`: browser + OS family
only). Sign-up entries carry the same two. A failed or refused attempt on a known account carries `account: user:<id>`.
Alerts (`security_alerts`, admin screen, once per kind + person + day; thresholds `SIGNIN_ALERTS` in `pure.ts`):
- `signin_failures_staff`: 5 failed / refused attempts on one staff account within 15 minutes (`SIGNIN_FAILURE_ACTIONS`).
- `signin_new_address`: a staff sign-in from an address that account has not signed in from within the retention
  period (only once the account has addresses on record, so the first sign-in after 19.11.2026 is not an alert).
- `signin_many_accounts`: 10 different accounts signed in from one address within 60 minutes (person = `address:<ip>`).
**Per-person view** (`GET /api/admin/audit/person?who=`, admin only, strict `audit.person_viewed`): everything one
account did (its entries as staff email and as `user:<id>`, and the failed attempts on it), its addresses and devices,
counts. Reached from the log ("מי"), from an alert, from the access reviews and from the staff screen. For a
candidate or an employer it shows the id and role, never the email.

## Logged actions (`audit_log.action`)
| Action | Strict | Actor | Details |
|---|---|---|---|
| `candidates.shown` | yes | content manager email | filters (`search: true` when there was a search, never the text), page, ids shown, count (new today), cut; `budget_owner` through an API key |
| `candidate.applications_viewed` | yes | content manager | ids [candidate], count; guest applications: `kind: guest`, ids = guest ids |
| `candidate.cv_opened` | yes | content manager | ids [candidate], count 1, via (page), type |
| `data.exported` | yes | `system:sandbox-export` | row counts |
| `candidate.cv_unlinked` (CV removed from a candidate's profile; the file is kept), `user.updated` (field names only) | no | content manager | ids. (`candidate.cv_deleted` is the old name, from when the file was erased) |
| `job.created`, `job.updated`, `jobs.internal_listed` | no | content manager | title / fields / counts; through the internal API also `ignored` (screen-owned fields it may not change) |
| `job.pinned`, `job.unpinned`, `job.bumped`, `job.board_updated`, `job.archived`, `job.restored` | no | content manager | `fields` (names only: `pinnedAt`, `bumpedAt`, `isSponsored`, `publishDate`, `status`, `guestModeOverride`, `quickCvOverride`, `regularCvOverride`, `deletedAt`) — see `docs/jobs-management.md` |
| `settings.apply_policy_updated` | no | content manager | new default values (`guestMode`, `quickCv`, `regularCv`: setting values, not personal data) |
| `settings.employer_posting_updated` | no | content manager | `mode`, `before` (`open` / `account_required`) |
| `settings.signup_fields_updated` | no | content manager / admin | `changed` (field names), `before` / `after` (`required` / `optional` / `hidden` for those fields: setting values, not personal data) |
| `settings.custom_field_created` | no | content manager / admin | target `custom_field:<id>`; `form` (`signup` / `job`), `type`, `label`, `required`, `active`, number of `options` (the staff's own wording, never an answer) |
| `salesforce.custom_field_linked` | no | admin | target `custom_field:<id>`; `form`, `object` (Contact / Case), `sf_field` and `before` (Salesforce API names or null), `status` (whether the org has it) |
| `settings.custom_field_updated` | no | content manager / admin | target `custom_field:<id>`; `form`, `changed` (names of the definition keys), the new `label` / `active` / `required` when those changed; `awaiting_admin` when a content manager's rewording turned a sign-up question off |
| `settings.custom_field_approved` (24.11.2026) | no | admin | target `custom_field:<id>`; `form`, `label`: an admin turned a sign-up question on (docs/settings.md "Sign-up questions need an admin") |
| `auth.signup_employer` (new employer account, when the sign-up form is sent with "employer") | no | `user:<id>` | role, `method` (`xhostd` / `microsoft` / `email_code`), `marketing`, `ip`, `device` |
| `employer.profile_updated`, `employer.submissions_claimed` | no | `user:<id>` (the employer) | target `self`; `fields` (names only) / `count`, `jobs`, `ids` (submission ids) |
| `jobs.edit_requested`, `jobs.edit_withdrawn` | no | `user:<id>` (the employer) | target = request id; `job`, `fields` (names only, never values) |
| `jobs.edit_requests_listed`, `jobs.edit_request_viewed`, `jobs.edit_request_approved`, `jobs.edit_request_rejected` | no | content manager | status / count / `job`, `fields` (names only) / `has_reason` (never the reason text) |
| `employer.applicant_forwarded` ("העברה למעסיק") | yes (no entry → the forward is withdrawn, 503) | content manager / admin | target = forward id; `kind` (`application` / `guest`), `application`, `ids` [candidate], `job`, `employer` (`user:<id>`) |
| `employer.forward_cancelled` ("ביטול העברה", only before the employer saw it), `employer.forward_cancel_refused` (`reason: seen`) | no | content manager / admin | same ids as above |
| `employer.applicants_shown` | yes | `user:<id>` (the employer) | ids [candidates shown], count (new today), shown, cut, `job` when filtered |
| `employer.cv_opened` | yes | `user:<id>` (the employer) | target + ids [candidate], count 1, via, type, `kind`, `job`, `forward` |
| `auth.login`, `auth.logout` | no | user | `auth.login`: role, `roles` (the roles this session carries, from 23.11.2026), `method` (`xhostd` / `microsoft` / `email_code`; `password` on entries before 11.2026), `ip` (the address), `device` (browser + OS family, e.g. `Chrome · Windows`; never the full user agent; from 19.11.2026) — `security/signins.ts` `auditLogin` |
| `auth.login_refused_deactivated` (Google / Microsoft sign-in of a deactivated account) | no | staff email / `user:<id>` | `method`, role, `account` (`user:<id>`), `ip`, `device`; counts towards a staff account's burst of failures |
| `cv.uploaded` (every CV file uploaded: sign-up form, personal area, application, guest application) | no | the uploader when signed in (`user:<id>`, a staff email), else `anonymous:<ip>` (sign-up form, guest application) | `upload` (`upload#<12 hex>`, keyed hash of the stored file — never its key or name), `type`, `size_kb` |
| `cv.attached` (an upload became someone's CV) | no | `user:<id>` / `anonymous:<ip>` (guest) | target = user id / guest id; `upload` (same hash as `cv.uploaded`), `via` (`signup` / `profile` / `application` / `guest_application`), `guest: true` |
| `auth.email_code_requested`, `auth.email_code_limited`, `auth.email_code_refused_staff`, `auth.email_code_refused_deactivated`, `auth.email_code_failed`, `auth.email_code_verified` | no | `anonymous:<ip>` | sign-in code by email (`controllers/emailSigninController.ts`). The typed email is **not** stored: target = `user:<id>` when the account exists, else `email#<12 hex>` (keyed hash, `typedEmailRef`; `auth.email_code_failed` / `verified` always the hash). On a known account the refusals (`limited`, `refused_staff`, `refused_deactivated`) also carry `account` (`user:<id>`), `ip` and `device`. Details: `account` (`existing` / `new`), `reason` (`too_soon` / `hourly` / `daily`; `wrong` / `locked` / `expired_or_used` / `none`), `attempts_left`, `step`, `next: signup`. **Never the code** |
| `auth.email_code_send_failed` | no | `system:email` | the email provider refused or timed out: `error` (`em2` not configured, `em3` timeout/network, `em4` refused, `suppressed` the address bounced or complained before) — never the response body |
| `mail.template_saved` | no | content manager / admin | target = the email kind; `version` (id). Never the subject or the text |
| `mail.template_published` | no | content manager / admin | target = the email kind; `version` (id) now sent |
| `mail.template_reset` | no | content manager / admin | target = the email kind; back to the default text |
| `mail.event_enabled` / `mail.event_disabled` | no | content manager / admin | target = the email kind (the sign-in code cannot be turned off while email sign-in is on: 409 `mail_event_locked`) |
| `mail.test_sent` | no | content manager / admin | target = the email kind; `status`. Sent only to the editor's own address, with sample values |
| `mail.suppression_removed` | no | content manager / admin | target = `email:` + the first 16 characters of the keyed hash of the address (never the address); `removed` |
| `mail.suppressed` | no | `system:resend` | Resend's webhook: a permanent bounce, a complaint or Resend's own suppression. Target as above (hash only); `reason`, `email_id` |
| `marketing.removed_by_staff` | **yes** | content manager / admin | a removal from marketing mail on the person's request (never an opt-in: no route exists). Target `user:<id>`, or `email:` + 16 characters of the keyed hash for an address without an account; `before` (state) or `by_address` |
| `marketing.unsubscribed` | no | `anonymous:<ip>` | the one-click link of a marketing email (`POST /api/unsubscribe`, signed token). Target `user:<id>` or `email:<hash16>` |
| `marketing.complaint` | no | `system:resend` | a spam complaint also removes the address from marketing. Target `user:<id>` or `email:<hash16>`; `email_id` |
| `auth.email_code_signup` (new candidate, when the sign-up form after a right code is sent) | no | `user:<id>` | role, `has_cv`, `marketing`, `ip`, `device` |
| `auth.candidate_passwords_cleared` (once, at the migration) | no | `system:migration` | `cleared` (count only) |
| `jobs.imported_purged` (once, at the migration, 17.11.2026) | no | `system:migration` | `jobs`, `applications`, `guest_applications` (counts only) |
| `users.candidates_purged` (once, at the migration, 17.11.2026, before Salesforce) | no | `system:migration` | `candidates`, `applications`, `forwards`, `cv_uploads_released` (counts only) |
| `jobs.test_jobs_purged` (once, at the migration, 17.11.2026: test jobs 1902, 1903) | no | `system:migration` | `jobs`, `applications`, `guest_applications` (counts only) |
| `auth.login_failed`, `auth.password_reset_requested`, `auth.password_reset`, `auth.login_refused_staff_password`, `auth.password_reset_refused_staff` | no | — | **until 11.2026 only** (password sign-in and reset were removed); kept in the log for its retention period |
| `auth.sso_linked` (first SSO sign-in of an existing account, staff or candidate; Microsoft: candidates only), `auth.signup_sso` (new candidate, when the sign-up form is sent) | no | staff email / `user:<id>` | role, `has_cv`, `provider` (`microsoft` when it was "Continue with Microsoft"); `auth.signup_sso` also `ip`, `device` |
| `auth.sso_password_cleared` (SSO linked to an existing candidate account that still had a password from before 11.2026: password cleared, every earlier session closed; the candidate is told on screen) | no | `user:<id>` | role, `sessions_closed`, `provider` (Microsoft) |
| `user.profile_updated` | no | `user:<id>` (the candidate) | target `self`; `fields` (names only), `removed` for a CV removal |
| `user.marketing_consent_changed` | no | `user:<id>` (the candidate) | target `self`; `marketing` (new answer), `before` (previous: true / false / null) |
| `user.terms_accepted` | no | `user:<id>` (the candidate) | target `self`; `PUT /users/me/terms`: `terms_accepted` (true when the current terms were accepted now), `marketing` (the first answer, or null when answered before) |
| `auth.oauth_failed` | no | `anonymous:<ip>` / user | provider (`xhostd` / `microsoft`), reason code (`state`, `invalid_token`, `expired`, `missing_token`, `already_linked_other`, `nonce`, `bad_tenant`, `no_email`, `unverified_email`, `staff`, `provider_<error>`, `token_http_<status>`, …) — never tokens or emails |
| `user.signed_up` (password sign-up, until 11.2026), `job.applied`, `guest.applied` | no | `user:<id>` / `anonymous:<ip>` | `marketing` (the optional box) on sign-up and guest apply; on `job.applied`, `terms_accepted` / `marketing` when the consent dialog was answered |
| `jobs.submitted`, `jobs.submission_dropped` | no | `anonymous:<ip>` / `user:<id>` (a signed-in employer) | target = submission id / reason (`honeypot`, `queue_full`); `by_account` when sent from an employer account; never the contact details |
| `jobs.submissions_listed`, `jobs.submission_viewed`, `jobs.submission_edited`, `jobs.submission_approved`, `jobs.submission_rejected` | no | content manager | status / count / field names only / job id / `has_reason` (never values or the reason text) |
| `access.denied` | no (throttled 10 min) | any | reason |
| `limits.refused`, `security.alert_raised` | no | content manager / `system:limits` | budget, used, allowed |
| `security.quota_granted`, `security.alert_handled`, `security.access_reviewed`, `security.admin_revoked` (staff → candidate role), `audit.searched` | no | admin | `self: true` when about oneself |
| `audit.person_viewed` ("פעילות של חשבון": everything one account did) | yes (no entry → 503, nothing sent) | admin | target `user:<id>`; role, `group`, `results` |
| `staff.invited` (target = staff email) | no | admin | role |
| `staff.role_changed` | no | admin | from, to (the staff role; `user` = none), `roles_before`, `roles_after`, self |
| `auth.role_added` (someone added the candidate / employer role to their own account, 23.11.2026) | no | the person | `role` (`user` / `employer`), `marketing`, `has_cv` (candidate) — never field values |
| `staff.deactivated`, `staff.reactivated` | no | admin | role |
| `staff.sessions_revoked` | no | admin | role, self |
| `users.role_blocked`, `users.role_unblocked` (24.11.2026, "חסימת תפקידים": one of the three kinds of role of an account blocked / unblocked) | no | admin | target = the account id; `role` (`user` / `employer` / `staff`), `roles` (the kinds it holds), `blocked_before`, `blocked_after`, `sessions_closed` (true on a block: every session closed, API keys revoked with `issuer_role_blocked`), `self` — never the person's data |
| `mail.address_keys_moved` (boot, 24.11.2026) | no | `system:migration` | how many rows of `marketing_optouts` / `mail_suppressions` moved from the legacy key to `MARKETING_OPTOUT_SECRET`'s (counts only) |
| `users.role_blocks_viewed` | no | admin | target = the account id; `by` (`id` / `email`: found by its email) |
| `auth.login_refused_blocked`, `auth.email_code_refused_blocked` | no | staff email / `user:<id>` / `anonymous:<ip>` | a sign-in (Google / Microsoft / code by email) refused because every role it would carry is blocked; the same details as the `_deactivated` refusals; counts towards a staff account's burst of failures |
| `staff.roles_split` (once, at the migration) | no | `system:migration` | admin email, number moved to content manager |
| `sandbox.refreshed` | no | admin (sandbox only) | counts |
| `api_token.created`, `api_token.revoked` | no | admin | target `token:<prefix>`; name, scopes, days, expiry (never the token); revoked: `reason` (`manual`, `issuer_deactivated`, `issuer_role_changed`, `issuer_sessions_revoked`, `issuer_role_blocked`) |
| `salesforce.pushed` | yes | `system:salesforce-sync` (the sync queue) / `token:<prefix>` / `system:internal-api` / staff (guest backfill) | kind (`job`, `candidate`, `employer`, `application`, `guest_application`), record ids, people's ids, count (written before sending) |
| `salesforce.checked` | no | admin | ok, names of the failed checks (read only: nothing sent) |
| `salesforce.retried` | no | admin | kind (or `all`), how many went back to the queue |
| `salesforce.cutover_report` | no | admin | whether the jobs part could be read (the report itself: counts and job ids only) |
| `legacy_jobs.mirrored` | no | admin or `system:legacy-jobs` | the existing site's jobs read from Salesforce: full read or not, how many read / added / updated / closed / skipped (by code), the public board's state |
| `legacy_jobs.taken_over` | no | `system:legacy-jobs` | the cutover at boot (`LEGACY_JOBS_MODE=owned`): how many of the existing site's jobs are now managed here |
| `legacy_jobs.returned_to_mirror` | no | `system:legacy-jobs` | the rollback at boot (`LEGACY_JOBS_MODE=mirror` again): how many went back to being mirrored |
| `legacy_candidates.mirrored` | no | admin or `system:legacy-candidates` | the existing site's candidates read from Salesforce: full read or not, how many read / added / updated / linked / skipped (by code). Counts only, never a name or email |
| `legacy_candidates.taken_over` | no | `system:legacy-candidates` | the cutover at boot (`LEGACY_CANDIDATES_MODE=owned`): how many copies became ordinary candidates |
| `legacy_candidates.returned_to_mirror` | no | `system:legacy-candidates` | the rollback at boot (`LEGACY_CANDIDATES_MODE=mirror` again): how many went back to view-only |

Through the internal API the actor of `candidates.shown`, `candidate.applications_viewed`, `candidate.cv_opened`,
`job.created`, `job.updated` (details `via: internal_api`), `jobs.internal_listed`, `limits.refused` and
`access.denied` is `token:<prefix>` or `system:internal-api`.

Staff are logged by email (`actorName`: admins, content managers and placement coordinators, lowercased), candidates as `user:<id>`.
Informational write failures are counted (`auditFailures`) and shown in the admin red banner.
Retention: 24 months (`AUDIT_RETENTION_MONTHS`), purged every 6 h by its own timer (`purgeAudit`); alerts, grants and
reviews too. Employer submissions: 12 months after review, or after sending if never reviewed (`purgeSubmissions`, 6 h). The trigger refuses UPDATE, TRUNCATE, and DELETE of rows younger than 24 months.

## Other protections
- Console output is redacted (`src/security/redact.ts`, imported first): DB errors print as `database error (code)`,
  emails/phones masked, third-party bodies not printed.
- `/api` refuses `Sec-Fetch-Site: cross-site|same-site` (unless the origin is in `ALLOWED_ORIGINS`); cookies are
  `SameSite=strict`, httpOnly; login no longer returns the tokens in the body.
- CV responses: `attachment`, `CSP: sandbox; default-src 'none'`, `CORP: same-origin`, `private, no-store`.
- Candidates list page size ≤ 50 (was 500). Anonymous uploads unclaimed for 24 h are deleted (`purgeStaleUploads`): only
  files nobody attached — not a profile, not an application, not a guest application (checked again in the query).
  No other code deletes a CV file: removing it from a profile (the candidate's or a content manager's) keeps the file.
- `/api` answers carry `Cache-Control: private, no-store`, except the public lists (`/jobs/active`, `/jobs/near`,
  skills, towns, health, providers). Every page: `Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()`.
- The service worker (installable app, `docs/pwa.md`) keeps only public files on the device (`/assets`, icons, fonts,
  images, manifest, offline page). It never touches `/api`, `/mcp`, file downloads or sign-in, and never stores a page:
  a cached copy of candidates' data would bypass the hand-overs. `test/unit/serviceWorker.test.ts` checks the rules.
- Sign-in code by email: the same answer for every address, sent before the account is looked at (see Sign-in).
  A sign-out closes every session (`sessions_revoked_at`).
- Access and refresh JWTs carry `typ` (`access` / `refresh`), checked on verify (HS256 only).
  `checkEnvVars` warns at boot when a JWT secret is shorter than 32 characters or two are equal; it refuses to start
  only with `STRICT_SECRETS=true`.
- Job lists for the site (board, map, page data) carry no employer contact details and no `uploadBy`; the
  self-apply view reads them from `GET /api/jobs/:jobId`.
- Low-severity fixes of the review of 24.11.2026:
  - L3: a staff member never approves a submission or an edit request of their OWN employer account, nor forwards
    candidates to it (403 `own_employer_account`, `security/roleFields.ts`). Another staff member handles it.
  - L4: an edit request's answer to a field the job page showed when the employer asked, and that is staff-only by
    the time of approval, is not written (`jobEditRequestController.stillValid`).
  - L5: `GET /custom-fields/job` gives staff-only fields (not shown on the job page) only to a signed-in employer or
    staff member; the anonymous employer form neither sees nor stores them (`customFieldsService.employerFacing`).
  - L6: a repeated quick application (same address and job) gets the same answer as a new one; nothing is stored,
    claimed or mailed, so the answer never tells whether an address applied.
  - L9: emails to addresses nobody verified (a guest's confirmation and "job closed", the employer form's decision)
    carry the name as one plain word only (dropped when it looks like a link or an address), and each such address
    gets a few of them a day at most (`mail/triggers.ts unverifiedName` / `unverifiedAllowed`, counted in memory by a
    keyed hash).

## Not covered (honest list)
- The DB owner role can drop the append-only trigger. Stronger: a separate DB role with INSERT/SELECT only on
  `audit_log`, or shipping the log off-site. Not set up (xhostd gives one DB user).
- Candidates' sign-in by code is as strong as their mailbox: whoever reads the inbox can sign in. Sessions made with a
  password before 11.2026 stay valid until they expire (60 days at most) or the candidate signs out.
- Files opened directly in Salesforce, emails to the notification address, and SMOOV are outside this log.
- An admin sees candidates and also oversees the log: with a single admin nobody reviews the admin's own use; add a
  second admin to close that. Role changes are logged (`staff.invited` / `staff.role_changed`) and access-reviewed.
- An admin can grant themselves more, confirm their own review and close alerts about themselves (marked `self`).
- The staff invite note is an email (`SEND_EMAIL_ENABLED`); while email is off, tell the new staff member yourself to
  sign in with Google.
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
- The public texts (`/privacy`, `privacyTexts.ts`) quote no internal numbers (owner, 20.11.2026), so changing `LIMITS` /
  retention / review period / alert thresholds needs no text change; `test/privacy.test.ts` keeps digits out. A new kind
  of data, purpose or recipient does: update the texts, bump the version, regenerate `docs/privacy/*.md`.
- Don't print personal data; `console.*` is redacted, but don't rely on it for new logging.
