# Jobs management (`/jobs-management`)

Placement coordinators, content managers and admins (client guard `VIEWER_ROLES`, server gate `staffViewers`, 19.11.2026).
A coordinator does everything here except the threshold condition and a job's apply settings (the checkboxes other than
"sponsored" and the apply-settings button are read-only for them; the server refuses with 403 `content_manager_required`,
`server/src/security/roleFields.ts`). The site-wide apply settings stay `contentManagerOnly`.
Admins are the security role and are refused (and signed out, as on every route above their role).
Code: `client/src/components/JobsManagement.tsx`, `JobTable.tsx`, `jobsAdmin/ConfirmDialog.tsx`;
rules in one pure module, `server/src/models/schemas/jobBoard.ts` (unit tests `server/test/unit/jobBoard.test.ts`,
end-to-end `server/test/e2e-jobs-admin.mjs`).

One screen: search, filters (status, sponsored, pinned, scheduled, archive view), order, and a table where each
job's board settings are edited in place: bump (↑) and pin buttons side by side, status, publish date, and one small
checkbox per column — sponsored, direct apply, quick apply, CV required (quick), CV required (regular). The column
names are in the header row, which stays frozen while the rows scroll. There is no crown any more: not in the table (the sponsored flag is a checkbox) and not on the public
job cards (they used to crown the two random "hot" jobs; the pin pill "נעוצה" is now the only mark). "Add job" and "Edit" open the existing job form
(`CreateOrEditJobContainer` / `JobDetails`), which now also has the publish date.

**Jobs imported from the existing site are read-only.** The jobs copied from the existing site
(`seed/live-snapshot.json`, `scripts/importFromLive.ts`) still live there and in its Salesforce, so this platform never
changes them: no edit, status, publish date, checkbox, pin, bump, archive or delete, from the screen, the job form,
the internal API or a Salesforce push (they are also left out of `push-pending`). They stay on the public board as
imported, but **take no applications here** (owner, 23.11.2026): the job page says so, and the server refuses every
regular, job-only-CV and quick application before anything is claimed or stored (409 `job_on_existing_site`,
`errorMiddleware.assertJobTakesApplications`; DB backstop `job_applications_legacy_guard` on `job_applications` and
`guest_applications`). The same holds for the jobs mirrored from the existing site (`legacy_state = 'mirror'`) until
the cutover. Jobs created on this platform take applications from every candidate, one copied from the existing site
included. Their apply mode still follows the site-wide defaults, which are read, not stored. Only jobs created on this platform can be added, edited and deleted.
- Marked by `jobs.imported_from_live` (set by the import, and on every migrate for the snapshot's ids: `db.markImportedJobs`).
- The server refuses first (`jobDAL.assertJobEditable` → 409 `job_read_only`, with a Hebrew message); a DB trigger
  (`jobs_imported_readonly`) refuses any UPDATE or DELETE that changes such a row, the mark itself included.
- The screen shows them with a lock and "מהאתר הקיים · לקריאה בלבד", with only the "view on the board" link.
- A second import run adds jobs that are new and never changes existing ones (`ON CONFLICT DO NOTHING`).
- **Production no longer has any (17.11.2026).** At the owner's decision the one-time migration
  `2026-11-purge-imported-jobs` (`db.migratePurgeImportedJobs`) removed the imported jobs with the applications and quick
  applications sent to them, so Salesforce is connected with only jobs created here (nothing is deleted in Salesforce).
  `launch.sh` no longer imports (`SEED_FROM_LIVE` is ignored); `importFromLive` is a local-development seed only, which is
  why the rules above still apply and are still tested.

**Jobs of the existing site, read from Salesforce until the cutover** (owner, 20.11.2026) — see the section at the end.

**The status is the only public/hidden switch.** Only an **Active** job appears on the site (board, map, job page,
public API, MCP); Suspended and Closed jobs are hidden everywhere, the direct link included. There used to be a separate
"private" (unlisted) flag; it was removed as a duplicate of the status. Migration `migration.no_private_v1` (runs once):
an Active job that was private became **Suspended**, so nothing hidden was published; the old `jobs.is_public` column
is kept for a rollback but no longer read.

## Board order: pin (נעץ) and bump (הקפצה) — the same everywhere the public sees jobs

Two buttons per job:
- **Pin (נעץ)** keeps the job at the start of every public list **until it is unpinned**. Pinned jobs carry a visible
  pin mark: in the management table (filled pin + "נעוצה מאז…") and on the public board's job cards (pin icon,
  "משרה נעוצה" for screen readers); the public API and MCP return `isPinned: true`. Pinning a pinned job changes
  nothing. Unpin returns the job to the normal order (its own publish date / last bump).
- **Bump (הקפצה, ↑)** moves the job to the top **once**: it is listed as if published at that moment, so it is the
  first job after the pins, and jobs published (or bumped) later go above it. The publish date shown is not changed.
  Bumping a **pinned** job moves it above the other pinned jobs (it does not change its bump time, so after an unpin
  it goes back to its own place).

Order:
1. Pinned jobs first; among them **the latest pin on top** (or the latest bump of a pinned job).
2. Then all other jobs by **listing time, newest first** = the later of the publish date and the last bump.
3. Ties: job id, descending (stable paging).

SQL: `pinned_at DESC NULLS LAST, GREATEST(publish_date, bumped_at) DESC, id DESC` (`PUBLIC_ORDER_SQL`; JS twin
`comparePublicOrder`). Columns: `jobs.pinned_at` (pinned since), `jobs.bumped_at` (last bump). Applied to the board
(`GET /api/jobs/active`; a `sortField` from the request is ignored there), the public API
(`/api/public/v1/jobs`) and MCP `search_jobs`. The map search (`/api/jobs/near`, public `/jobs/near`, MCP `jobs_near`)
keeps the pins first, then nearest first. The board's two random "hot" (`isMarked`) jobs
(`includeRandomSponsoredJobs`) are drawn from unpinned jobs only and placed right after the pinned ones.

Pin/unpin: `POST` / `DELETE /api/admin/jobs/:jobId/pin`; bump: `POST /api/admin/jobs/:jobId/bump` (content managers
only). Archiving a job clears its pin; an archived job can't be pinned or bumped. Integrations can't pin or bump
(`pinnedAt`, `bumpedAt` are screen-only).

## Who the public sees

`PUBLIC_LISTING_SQL` / `isPubliclyListed`: status **Active**, **not archived**, and the **publish date has
come**. Used by the board, map search, the public API and MCP (list and by id) — and by any sitemap that is added later
(there is none today).

| Job | Board / map / public API / MCP | Direct link `/job/:id` and applying |
|---|---|---|
| Active, published | yes | yes |
| Scheduled (publish date in the future) | no, until that date | no (404 for the public; content managers see it) |
| Archived (deleted) | no | no (404; content managers see it) |
| Suspended / Closed | no | no (as before) |

## Publish date (תאריך פרסום) and scheduling

Edited inline (date field + "save") or in the form. Server check `checkPublishDate`:
- not before 2015-01-01; a date up to 10 minutes ahead counts as now;
- a **future** date is accepted only with `schedulePublish: true` (the UI asks: a "schedule publishing" box) and at most
  365 days ahead (`publish_date_future_needs_schedule`, `publish_date_too_far`, `publish_date_invalid`, `publish_date_too_early`);
- a scheduled job is hidden from the public until the date and is listed under the "scheduled only" filter.
The same check runs on `POST /api/jobs`, `PATCH /api/jobs/:jobId` (the form) and the internal API.

## Per-job settings in the list

`PATCH /api/admin/jobs/:jobId/board` takes only `isSponsored` (sponsored), `publishDate`
(+ `schedulePublish`), `status`, `guestModeOverride`, `quickCvOverride`, `regularCvOverride` (null = inherit the site
default; see "Ways to apply").
Anything else → 400 `bad_field`. Everything else about a job is edited in the full form.

## Ways to apply (אופן ההגשה) and CV rules

Pure rules: `server/src/models/schemas/applyPolicy.ts` (unit tests `server/test/applyPolicy.test.ts`; end-to-end
`BASE=http://localhost:3100 node test/e2e-apply-modes.mjs`, 14 checks).

| Who | What they can do |
|---|---|
| Visitor, not signed in — guest mode **self** (הגשה עצמאית) | The job page shows a "מגישים ישירות למעסיק" box with the employer's contact as stored on the job and the external link; they apply directly. `guestApply` is refused (`jb12`). |
| Visitor, not signed in — guest mode **quick** (הגשה מהירה) | The guest form (name, email, phone, CV), handled by the nonprofit. |
| Visitor, not signed in — guest mode **none** (סגורה) | Sign in / register first (`guestApply` → `jb10`). |
| Registered and signed in | Regular apply (הגשה רגילה), **always**, whatever the guest mode. On a self-apply job the employer box is shown too. |

CV rule — **required** or **optional**, set separately:
- **quick** + required: the guest form demands an upload; the server refuses without a claimable upload (`jb11`).
- **regular** + required: with a CV on the profile the candidate applies with it (or replaces it / uses a job-only
  file, as before); without one the dialog demands an upload, and the server refuses a "profile" application
  without a profile CV (`jb11`).

Two levels: the site-wide default (on the settings screen, `/settings#settings-apply` → `PUT /api/admin/settings/apply-policy`
`{ guestMode, quickCv, regularCv }`, logged as `settings.apply_policy_updated`) and per-job overrides in the table
("הגשה ללא הרשמה", "קו״ח") or the job form (`guestModeOverride`, `quickCvOverride`, `regularCvOverride`; null = default).
A new job starts on the default for all three.

- **Public payload:** the site, the public API and MCP get only the effective `applyPolicy` / `applyMode`, never the
  overrides. The employer contact (`contactPersonName/Phone/Email`) is sent to the public **only on self-apply jobs**
  (site: `jobDAL.rowToJob`; API/MCP: `applyContact`). Employer-form jobs carry only the employer's public application
  email there; the submission's internal contact person never reaches a job.
- **isSelfApply** (and Salesforce `isSelfApply_cambium__c`) = the effective guest mode is self. The column
  `jobs.is_self_apply` is kept equal to it on every write and when the default changes. Old clients and integrations
  may still send `isSelfApply`: true → `guestModeOverride: 'self'`; false → back to the default only if the job was
  self. Once a content manager set the guest mode on the screen, integrations can't change it (`guestModeOverride` is a
  managed field; `isSelfApply` is ignored with it).
- **Migration** (once, `config/db.ts`, marker `app_settings 'migration.apply_modes_v1'`): `is_self_apply` → `self`;
  `quick_apply_override` true/false → `quick`/`none`; `quick_apply_without_cv_override` true/false → `optional`/`required`;
  the settings row `{ quickApply, quickApplyWithoutCv }` → `{ guestMode: quick|none, quickCv, regularCv: optional }`.
  The old columns are left in place (no longer read) for a rollback.

## Threshold condition (תנאי סף)

One optional, short **plain-text** condition per job — e.g. "at least 2 years in marketing and sales", "a valid
lawyer's licence", "a bookkeeping course, level 2". Rules: `server/src/models/schemas/thresholdCondition.ts`
(unit tests `test/unit/thresholdCondition.test.ts`).

- **Who sets it:** content managers and admins in the job form ("תנאי סף", under the comments); employers in the job
  form (`/post-job`, signed in or not) and in an **edit request** (pending until a content manager approves; shown in
  the before/after view like every other field); integrations through the internal API (`thresholdCondition`).
  Jobs imported from the existing site are read-only, so they never have one.
- **The text:** tags, control characters and bidi overrides are removed, line breaks kept, 3–500 characters; empty =
  no condition. Stored in `jobs.threshold_condition` (DB CHECK ≤ 500) and shown everywhere as text, never as HTML.
  Errors: `threshold_condition_too_short|too_long|invalid` (staff / internal API), the field code in the employer form.
- **Public:** the job page shows it in a box ("תנאי סף") and the public API / MCP carry `thresholdCondition`
  (string or null).
- **Applying:** every way to apply through SKEELZ — a regular application (any CV choice) and a quick (guest)
  application — first shows a pop-up with the text and a checkbox "אני מאשר/ת שאני עומד/ת בתנאי הסף"
  (`client/src/components/threshold/ThresholdConfirmDialog.tsx`: labelled, focus kept inside, Escape = cancel).
  The client reads the job again right before, so the text confirmed is the current one. **The server enforces it:**
  an application to a job with a condition is refused with **400 `threshold_not_confirmed`** (with the current text)
  unless the request carries `thresholdConfirmed: true`, checked before any CV is claimed or anything is stored.
  Self-apply (הגשה עצמאית) goes to the employer directly, outside SKEELZ, so there the box on the job page is all.
- **Stored with the application:** only `threshold_confirmed` (true) and `threshold_confirmed_at` on
  `job_applications` / `guest_applications`. No other data about the candidate.
- **Salesforce** (owner's request, 11.2026; off in prod: `ENABLE_SALESFORCE`): the job Case gets the text in
  `Threshold_Condition__c` (every create and edit, same Case; null when removed), the application Case gets
  `Threshold_Confirmed__c` + `Threshold_Confirmed_At__c` (quick applications too). The text as it was at confirmation
  is not stored, so not sent. A field the org lacks is skipped, and the connection check names it
  (`threshold_fields_missing`, a warning). Fields to create: docs/salesforce.md section 5ב.

## Delete = archive (soft), with undo and restore

`POST /api/admin/jobs/:jobId/archive` sets `deleted_at` / `deleted_by`; nothing else changes (status, sponsored,
apply policy are kept), except the pin, which is cleared. The confirm dialog says how many applications the job has
(`GET /api/admin/jobs/:jobId/applications-count`, a number only) and that they are kept. After the delete the screen
offers **Undo**; the "deleted jobs (archive)" view lists archived jobs with **Restore** (`POST …/restore`).
Applications are never deleted with a job: nothing in the code deletes jobs, and a DB trigger
(`jobs_keep_applications`) refuses a hard `DELETE` of a job that has applications (`job_applications.job_id` cascades).

## Activity log

| Action | Details |
|---|---|
| `job.created`, `job.updated` | title (created) / `fields` (names only) |
| `job.pinned`, `job.unpinned` | `fields: ['pinnedAt']` |
| `job.bumped` | `fields: ['bumpedAt']` (or `['pinnedAt']` when a pinned job was bumped above the other pins) |
| `job.board_updated` | `fields` (names only, e.g. `['status']`, `['publishDate']`) |
| `job.archived`, `job.restored` | `fields: ['deletedAt']` |

Actor = the content manager's email. Labels: `ACTION_LABELS` in `SecurityManagement.tsx`; table: `docs/security.md`.

## Integrations (internal API, Salesforce) never overwrite the board

- Pin, bump and archive are **screen-only**: the internal API ignores `pinnedAt`, `bumpedAt`, `deletedAt` (and the retired `isPublic`)
  (create and update) and reports them in `ignored`.
- `isSponsored`, `publishDate` and the guest mode (`guestModeOverride`, with the legacy `isSelfApply`) become **screen-owned** once a content manager sets them here (create or edit on the
  screen / form, or an inline change): recorded per job in `jobs.managed_fields`. An integration's update then leaves
  them as they are and lists them in the answer's `ignored` (logged as `job.updated` with `via: internal_api, ignored`).
  A job created by an integration and never touched here can still be changed by it.
- Salesforce sync is push-only today (`salesforceService.upsertJobCase` etc., off in prod: `ENABLE_SALESFORCE`); pin
  and bump are not pushed; an archive / restore is (the job's site status `PStatus__c` becomes `Closed` / back). Anything that later writes jobs **from** Salesforce must go through
  `updateJobById(…, 'integration')` (or `stripManagedFields`) to keep this rule. `scripts/importFromLive.ts` (one-time
  local import from the old site) is not an integration and still overwrites on conflict.

## Jobs of the existing site (the cutover)

Every job of the existing site (jobs.skeelz.co.il) lives here too, under **the same `_id` and job number**, so its links
(`/job/<_id>`), its applications and its Salesforce Position Case stay the same. Who manages them is one setting,
`LEGACY_JOBS_MODE` (code: `server/src/services/legacyJobs.ts`, pure rules `legacyJobsPure.ts`, unit tests
`test/unit/legacyJobs.test.ts`, end to end `test/e2e-cutover.mjs`):

| Mode | Who manages them | Here |
|---|---|---|
| `off` (default) | — | nothing is read; jobs already here keep their state |
| `mirror` | the existing site | every `LEGACY_JOBS_MIRROR_MINUTES` (default 5) the mirror **reads** their Position Cases from Salesforce — only those changed since the last read (a full read on the first run or on request) — and updates the copies: status and fields. **Read-only here** (409 `job_read_only`, and the DB trigger `jobs_legacy_guard`), never pushed. Candidates apply as usual; the application Case names the job's `_id` (`A_PID_cambium__c`), so the `new_applied` Flow links it to the same Position |
| `owned` | this site (after the cutover) | at boot every mirrored job becomes `owned` (logged `legacy_jobs.taken_over`); the mirror stops; staff manage them on this screen; a change goes through the queue to **the same Position Case** (the id the mirror stored, else looked up by `PID_cambium__c`): never a new Case, never the Beta mark, record type / Account / owner / Case status untouched. A job with no Case gets one, as usual |

Back to `mirror` is the rollback (logged `legacy_jobs.returned_to_mirror`): the copies follow Salesforce again.

- **What is read.** Cases of the jobs record type (`SALESFORCE_CASE_RECORD_TYPE_ID`) with a `PID_cambium__c`, not marked
  Beta (this site's own), **in any Account**: the team moves many of them to the employer's Account (in the org, 11.2026:
  1,840 such Cases, 882 still in "משרות קמביום"; 34 active = the existing site's board). Read only (SOQL); nothing is
  written to Salesforce by the mirror. Fields: those this site writes for its own jobs (docs/salesforce.md section 1),
  read back tolerantly: skills by id or name, scope `FullTime` / `PartialTime` (or מלאה / חלקית), the city by symbol or
  name, HTML entities decoded, the external-link line of the comments → the external link. An empty status (the oldest
  jobs) = Closed. Skipped, by code: `bad_pid`, `no_title`, `no_city`; a job made here with the same id: `not_legacy`.
- **The existing site's public board** (`LEGACY_PUBLIC_API`, GET only, optional) adds what Salesforce lacks: the job
  number, the description as formatted there, the person who uploaded it, its cities and skills. A job on the board
  with no Case is added from the board alone, and closed when it leaves the board.
- **Job numbers.** The existing site's jobs keep theirs; jobs made here start above `JOB_NUMBER_FLOOR` (default 3000),
  so two jobs never share a number.
- **Admins** (security screen → Salesforce card → "משרות האתר הקיים"): mode, last read, counts, "read now", a full read,
  and the **cutover report** (read only): Position Cases against the jobs here (not here, active there and not here,
  here without a Case — job ids), and how candidates' Contacts were matched. Routes:
  `GET /api/admin/security/salesforce/legacy-jobs`, `POST …/legacy-jobs/run` (`{ full? }`), `GET …/cutover-report`
  (all `adminOnly`). Logged: `legacy_jobs.mirrored` (with counts, when something changed or an admin asked),
  `salesforce.cutover_report`.
- The connection check has a row for it (`legacy_edit_access`): may the integration user edit the existing site's
  Position Cases? A warning while mirroring, a failure in `owned` mode — a Sharing Rule is needed before the cutover.

**The switch, in order** (owner, 20.11.2026: this site takes over the existing site's address, jobs.skeelz.co.il, so
every link to it keeps working: running campaigns land on `/` and on `/job/<_id>`, with UTM tags):
1. Days before: `LEGACY_JOBS_MODE=mirror`, `LEGACY_PUBLIC_API` = the existing site's **direct CloudFront address**
   (`…cloudfront.net/api`; jobs.skeelz.co.il will point here after the switch). Check the cutover report, and that every
   landing page of the running campaigns (`/job/<_id>`) opens here.
2. Freeze job edits on the existing site.
3. `CLIENT_BASE_URL` / `PUBLIC_SITE_URL` = https://jobs.skeelz.co.il, `LEGACY_JOBS_MODE=owned`, restart.
4. DNS: jobs.skeelz.co.il → this app (domain added on xhostd first). Check `/` and real campaign links with their UTM.
5. `ALLOW_INDEXING=true` (indexing only on the `PUBLIC_SITE_URL` host, `docs/seo.md`), then `REDIRECT_TO_CANONICAL=true`
   (j.skeelz.co.il → the same path on jobs.skeelz.co.il). Submit the sitemap in Search Console.
6. The existing site stops writing jobs to Salesforce; `SALESFORCE_BETA_MARK=false` (docs/salesforce.md).

Rollback: DNS back to CloudFront (the existing site can't run on another host: its API address is fixed), and here
`LEGACY_JOBS_MODE=mirror`, `REDIRECT_TO_CANONICAL=false`, `SALESFORCE_BETA_MARK=true`.
