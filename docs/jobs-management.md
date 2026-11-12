# Jobs management (`/jobs-management`)

Content managers only (client guard `[CONTENT_MANAGER]`, server gate `contentManagerOnly` on every route below).
Admins are the security role and are refused (and signed out, as on every route above their role).
Code: `client/src/components/JobsManagement.tsx`, `JobTable.tsx`, `jobsAdmin/ConfirmDialog.tsx`;
rules in one pure module, `server/src/models/schemas/jobBoard.ts` (unit tests `server/test/unit/jobBoard.test.ts`,
end-to-end `server/test/e2e-jobs-admin.mjs`).

One screen: search, filters (status, public/private, crown, pinned, scheduled, archive view), order, and a table where
each job's board settings are edited in place. "Add job" and "Edit" open the existing job form
(`CreateOrEditJobContainer` / `JobDetails`), which now also has the publish date and "private job".

## Board order (הקפצה) — the same everywhere the public sees jobs

1. Pinned jobs first, **the most recently pinned on top** (pinning a pinned job again moves it above the other pins).
2. Then all other jobs by **publish date, newest first**.
3. Ties: job id, descending (stable paging).

SQL: `pinned_at DESC NULLS LAST, publish_date DESC, id DESC` (`PUBLIC_ORDER_SQL`). Applied to the board
(`GET /api/jobs/active`; a `sortField` from the request is ignored there), the public API
(`/api/public/v1/jobs`) and MCP `search_jobs`. The map search (`/api/jobs/near`, public `/jobs/near`, MCP `jobs_near`)
keeps the pins first, then nearest first. The board's two random "hot" (`isMarked`) jobs
(`includeRandomSponsoredJobs`) are drawn from unpinned jobs only and placed right after the pinned ones.

Pin/unpin: `POST` / `DELETE /api/admin/jobs/:jobId/pin`. Archiving a job clears its pin; an archived job can't be pinned.

## Who the public sees

`PUBLIC_LISTING_SQL` / `isPubliclyListed`: status **Active**, **public**, **not archived**, and the **publish date has
come**. Used by the board, map search, the public API and MCP (list and by id) — and by any sitemap that is added later
(there is none today).

| Job | Board / map / public API / MCP | Direct link `/job/:id` and applying |
|---|---|---|
| Active, public, published | yes | yes |
| Private (`is_public = false`) | no | **yes** — "unlisted": a content manager can send the link to chosen people |
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

`PATCH /api/admin/jobs/:jobId/board` takes only `isPublic`, `isSponsored` (the crown on the cards), `publishDate`
(+ `schedulePublish`), `status`, `quickApplyOverride`, `quickApplyWithoutCvOverride` (null = inherit the site default).
Anything else → 400 `bad_field`. Everything else about a job is edited in the full form.

## Delete = archive (soft), with undo and restore

`POST /api/admin/jobs/:jobId/archive` sets `deleted_at` / `deleted_by`; nothing else changes (status, visibility, crown,
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
| `job.board_updated` | `fields` (names only, e.g. `['isPublic']`, `['publishDate']`) |
| `job.archived`, `job.restored` | `fields: ['deletedAt']` |

Actor = the content manager's email. Labels: `ACTION_LABELS` in `SecurityManagement.tsx`; table: `docs/security.md`.

## Integrations (internal API, Salesforce) never overwrite the board

- Pin, visibility and archive are **screen-only**: the internal API ignores `pinnedAt`, `isPublic`, `deletedAt`
  (create and update) and reports them in `ignored`.
- `isSponsored` and `publishDate` become **screen-owned** once a content manager sets them here (create or edit on the
  screen / form, or an inline change): recorded per job in `jobs.managed_fields`. An integration's update then leaves
  them as they are and lists them in the answer's `ignored` (logged as `job.updated` with `via: internal_api, ignored`).
  A job created by an integration and never touched here can still be changed by it.
- Salesforce sync is push-only today (`salesforceService.upsertJobCase` etc., off in prod: `ENABLE_SALESFORCE`); pin,
  visibility and archive are not pushed. Anything that later writes jobs **from** Salesforce must go through
  `updateJobById(…, 'integration')` (or `stripManagedFields`) to keep this rule. `scripts/importFromLive.ts` (one-time
  local import from the old site) is not an integration and still overwrites on conflict.
