# Employer accounts (חשבונות מעסיקים)

Added 11.2026. Code: `server/src/security/employer.ts` (pure rules, unit tests `server/test/unit/employer.test.ts`),
`server/src/controllers/employerController.ts` (the employer's area), `server/src/controllers/jobEditRequestController.ts`
(the content managers' queue), `server/src/services/employerAccounts.ts` (sign-up, Salesforce), `server/src/dal/employerDAL.ts`.
End-to-end: `BASE=http://localhost:3100 node test/e2e-employers.mjs`; bypass attempts (IDOR, refusals, response shapes,
role transitions): `BASE=http://localhost:3100 [DATABASE_URL=…] node test/e2e-employer-isolation.mjs` (restart the server first).

## The setting: who may post a job

The settings screen (`/settings`, content managers and admins; section "טופס משרה ופרסום משרות", anchor `#settings-posting`,
its own save button) has **פרסום משרות על ידי מעסיקים**:

| Value | What happens |
|---|---|
| `open` (default — today's behaviour) | The anonymous form `/post-job` works as before. A signed-in employer's submission is also linked to their account. |
| `account_required` | Only a signed-in **employer** account can send a job. Anonymous → 401 `employer_sign_in_required` (the page shows "sign in to post a job"); a candidate or staff account → 403 `employer_account_required`. |

Server-enforced in `POST /api/job-submissions` (`postingRefusal`, the role from the DB). API: `GET|PUT
/api/admin/settings/employer-posting` `{ mode }` (logged `settings.employer_posting_updated`); the public page reads
`GET /api/job-submissions/policy` (the mode only).

## The employer role

`'employer' = ANY(users.roles)` (`UserRole.EMPLOYER`). Since 23.11.2026 one account may hold several roles (owner: "a
user can be a candidate, an employer and a content manager / admin at once"; `docs/security.md` "Several roles per
account"). The employer ROLE is never a staff role (not in `STAFF_ROLES` / `REVIEWED_ROLES` / `ASSIGNABLE_ROLES`) and
never opens a candidate or staff route: `signedIn` admits the candidate and staff roles only, so an employer-only account
is refused on every candidate route (`/users/me`, applying, applications, CVs) and every staff route (and, as for every
role, a refused session is signed out). The only gate that admits the employer role is `employerOnly`
(`/api/employer/*`), checked in `test/gates.test.mjs`. Someone who is ALSO a candidate or staff passes those gates by
that other role, with that role's limits. Candidate lists, the internal API and Salesforce candidate pushes filter
`'user' = ANY(roles)`, so an employer-only account never appears among candidates.

The employer's own details are in `employer_profiles` (company, phone, job title); `users` keeps name and email
(`phone_number` NULL, `city_symbol` 0, no password).

### Signing in and signing up

The same three ways as candidates: "Continue with Google" (xhostd SSO), "Continue with Microsoft", a code by email.
After the identity is verified, a **new** address gets a sign-up form straight away — there is no "employer or job
seeker?" screen (owner, 11.2026). **Who is an employer is decided by where they came from:** the employer buttons — the
sign-in on `/post-job` (in both posting settings: with `open` a box above the form, "sign in as an employer"; with
`account_required` the sign-in card) and the guarded employer area `/employer` — call `openEmployerLogin`
(`client/src/components/employer/employerApi.ts`), which remembers "employer" for this tab (it survives the Google /
Microsoft redirect). Every other way in — the header's "התחברות", applying for a job, other guarded pages — forgets it,
so the person is a job seeker and gets the candidate form. The employer form: first name, last name, company, phone,
optional job title, the two consent boxes from `security/consent.ts`. The employer form posts to the same sign-up endpoint with
`accountType: 'employer'`; the email still comes only from the signed sign-up cookie.

**Role conflicts (decided):**
- **Several roles per account** (owner, 23.11.2026; was "one role per account"). A NEW address becomes an employer on the
  sign-up form, as above. An address that already has an account (candidate, staff) signs in to that account, and the
  person adds the employer role from inside it: `/join/employer` (also linked from `/post-job` and the personal area) →
  `POST /api/users/me/roles/employer` with the same form and consent (logged `auth.role_added`). Same email, same sign-in.
  The reverse: an employer adds the candidate role at `/join/candidate` (`POST /api/users/me/roles/candidate`, the
  candidate sign-up fields and consent).
- No sign-up path turns an existing address into an employer by itself: the sign-up form is only for new addresses.
- **Staff** who are also employers: the staff role counts only on a Google session; by code or Microsoft they are the
  employer (and candidate) only. A staff-only address still signs in only with Google (`staff_google_only`).
- An admin adds a staff role to an employer's (or candidate's) account on the staff users screen; the employer role
  stays. An admin can't assign the employer role there (`ASSIGNABLE_ROLES`): the person adds it themself.
- **Budgets:** an employer's daily budgets (`employerPeople` / `employerCvs`) belong to the account (`user:<id>`) whatever
  the session, also when a staff member who is an employer views on a Google session (logged by email with
  `budget_owner`); they are never shared with the staff budget.
- An employer who is also a candidate keeps the name in the personal area: the employer form doesn't change it.
- Microsoft links an existing **employer** by its verified email the same way it links a candidate (`linkMsSub`).

## Salesforce: Account + Contact (only with `ENABLE_SALESFORCE=true`; off in production)

At sign-up and when the employer changes their details, the employer is queued (`services/salesforceSync.ts`) and
`salesforceService.upsertEmployer` writes, after a strict `salesforce.pushed` entry (`kind: employer`, the user id):
an **Account** for the company they entered, then a **Contact** for the person under that Account (owner's rule,
11.2026). Both are found again by `SKEELZ_Employer_Id__c` (the user id; Text 24, External ID, Unique, required on
Contact AND Account — without it nothing of an employer is sent, `employer_id_field_missing`), so only records this
site made are ever touched: never an Account the team created. State in `salesforce_sync` (`kind = 'employer'`):
Contact id (`sf_id`), Account id (`sf_account_id`), times, error code only. With Salesforce off nothing leaves the
server and nothing is stored. Both records carry the Beta mark. Setup: docs/salesforce.md.

| Account field | Value |
|---|---|
| `Name` | the company name (else the employer's name) |
| `RecordTypeId` | `SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID` when set (NPSP: Organization); kept on updates |
| `Description` | `SKEELZ Jobs employer account <user id>` |
| `SKEELZ_Employer_Id__c` | the employer's user id |

| Contact field | Value |
|---|---|
| `FirstName`, `LastName` | the employer's name |
| `Email` | the verified sign-in email |
| `Phone` | the employer's phone |
| `Title` | the employer's job title, when given |
| `AccountId` | the company's Account above (never the candidates' Account) |
| `Description` | `SKEELZ Jobs employer account <user id>` |
| `SKEELZ_Employer_Id__c` | the employer's user id |
| `Is_SKEELZ_Employer__c` (optional) | `true` (Checkbox), when the org has it |

A job an employer account posted (`employer_jobs`) points at that Contact (`ContactId` on its Case); a new Contact
re-queues the employer's jobs already sent. Each employer gets an Account of their own (two people from one company →
two Accounts, merged by hand in Salesforce if wanted).

## The employer's area (`/employer`)

Signed-in employers see "אזור אישי" → `/employer`:
- **My details** — name, company, phone, job title (email read-only). `PATCH /api/employer/me` (logged
  `employer.profile_updated`, field names only).
- **My submissions** — pending / approved / rejected, with the date, the reject reason when given, and a link to the
  job once published. A submission sent while signed in carries the account (`job_submissions.submitted_by_user_id`).
- **מועמדים למשרות שלי** — only the applicants a content manager forwarded (name + CV); see "Applicants" below.
- **My jobs** — the published jobs from their approved submissions (`employer_jobs`, linked at approval): status,
  publish date, archived, and the edit button. Kept when the submission itself is purged after 12 months.

**Earlier anonymous submissions (decided):** the area offers "צירוף משרות ששלחתם בעבר" when there are anonymous
submissions whose **contact email is the account's sign-in email**. Only that email, only unowned submissions, only on
the employer's click (`POST /api/employer/submissions/claim`, logged `employer.submissions_claimed` with the ids). Safe
because the sign-in email is verified (Google, Microsoft verified email, or the code by email); someone else's
submissions can't be claimed. Approved ones bring their job into "My jobs".

## Edit requests (בקשות עריכה)

An employer edits one of **their** published jobs → `POST /api/employer/jobs/:jobId/edit-requests`. Stored in
`job_edit_requests` as **pending**; the live job is **not changed**. **Every field of the job** (owner, 24.11.2026:
"employers may edit any field with staff approval"; `EDITABLE_JOB_FIELDS`): title, company, city, scope, skills,
description (plain text, as in the form), application link, public application email, threshold condition ("תנאי סף",
optional plain text; `docs/jobs-management.md` "Threshold condition") with the public form's rules; the job's public
contact name and phone (shown only on a self-apply job; empty clears); its status (Active / Suspended / Closed); its
apply settings (`guestModeOverride`, `quickCvOverride`, `regularCvOverride`; empty = the site's default); and every
active added job field (`docs/settings.md`: those not shown on the job page are write-only for the employer). Not
fields of the job but how SKEELZ runs the board, so never in a request (400 `bad_field`): pin / bump, sponsored,
publish date and schedule, internal comments, archive. One pending request per job (409 `edit_pending`); the employer
can withdraw it. **Who approves:** a coordinator or a content manager; a change of the threshold condition or of an apply
setting only a content manager (403 `content_manager_required` with the field names; `CONTENT_MANAGER_FIELDS` in
`security/roleFields.ts`). End-to-end: `test/e2e-role-blocks.mjs`.

Content managers see a second tab on **"משרות ממעסיקים"**: **בקשות עריכה**. Opening one shows, per field, the value when
the employer asked, the value now (marked if it changed since) and the requested value. **Approve** applies the change
through `jobsService.updateJobById(…, 'screen')` (description converted to safe HTML, Salesforce updated only when on)
and logs `jobs.edit_request_approved` + `job.updated` (`via: employer_request`); **Reject** keeps the job, with an
optional reason the employer sees (`jobs.edit_request_rejected`, `has_reason` only).

**Jobs imported from the existing site are read-only:** an edit request for one is refused (409 `job_read_only`) and
the area shows it with a lock and no edit button; approval goes through `assertJobEditable` too.

Retention: reviewed or withdrawn requests are deleted with the submissions' period (`SUBMISSION_RETENTION_MONTHS`, 12).

## Applicants (מועמדים למשרות שלי) — owner's decisions 11.2026

Code: `server/src/dal/forwardDAL.ts`, `controllers/employerForwardController.ts` (staff),
`controllers/employerApplicantsController.ts` (employer), pure rules in `security/pure.ts`
(`EMPLOYER_ACCESS_DAYS`, `employerWindowOpen`, `forwardCancelRefusal`). End-to-end:
`BASE=… DATABASE_URL=… node test/e2e-employer-applicants.mjs`.

- **Added fields** (the settings screen, `docs/settings.md`): a candidate's answers to added sign-up questions never reach
  an employer. The employer form and edit requests carry the active added JOB fields (owner, 23.11.2026), with the same
  rules as the staff form; since 24.11.2026 an edit request covers every active job field, the staff-only ones write-only (their answers are never shown
  to an employer) and changes them only after a coordinator or content manager approves.
- **Nothing reaches an employer automatically.** A content manager (or admin) presses **"העברה למעסיק"** on one
  application (`POST /api/admin/employer-forwards { kind, applicationId }`): registered applications (`job_applications`)
  and quick ones (`guest_applications`), to a job the employer owns through `employer_jobs`. Until then the employer
  sees nothing about it, not even a count. Jobs imported from the existing site have no owner here → refused
  (`no_employer`), never shown. A deactivated employer — or one whose employer role an admin blocked (24.11.2026, `docs/security.md`
  "Blocking a role") — can't receive (`employer_inactive`) and loses access at once (the gate reads the DB on every request).
- **What the employer sees** (`GET /api/employer/applicants`, the "הצגת המועמדים" button on `/employer`): per job,
  each forwarded applicant's **name**, the **forward date**, whether there is a CV, and "פתיחת קורות חיים"
  (`GET /api/employer/applicants/:forwardId/cv`, downloaded as `cv.pdf` / `cv.docx`). No email, phone, city, other
  profile fields, candidate id or application id in any answer; the forward id is the only handle. Contact goes
  through the SKEELZ team. For a registered application the CV is the one sent with that application.
- **Window:** while the job is active (status `Active` and not removed from the board), and until
  `EMPLOYER_ACCESS_DAYS` (90) days after it stopped being active. "Stopped being active" = the moment its status left
  `Active` or it was removed (`deleted_at`), stored in `job_inactive_since` by a DB trigger on `jobs` (every path); it
  is cleared when the job is active again (the window then has no end again). Jobs that were already inactive when the
  trigger was added got `deleted_at`, else `updated_at`, as the moment. After the window the applicant disappears from
  the employer's area; nothing is deleted (forwards, applications and CVs stay; staff and Salesforce keep everything).
  A private (`is_public = false`) or scheduled job still counts as active.
- **Cancel ("ביטול העברה"):** `POST /api/admin/employer-forwards/:id/cancel` works only while the employer has not been
  shown the applicant. "Shown" = the first time it was in the employer's list answer or its CV was opened
  (`first_seen_at`). After that it can't be undone (409 `forward_seen`, logged `employer.forward_cancel_refused`); the
  DB trigger enforces the same. A cancelled forward can be forwarded again (a new row). Cancel and the employer's view
  race safely: the cancel is one conditional UPDATE, and the list drops a forward cancelled between reading and marking.
  Marking happens only after the strict log entry was written (list and CV): a refused log (503, nothing sent) leaves
  the forward unseen and still cancellable; a CV whose forward was cancelled in between is not sent (404).
  The employer's list loads only when they press "הצגת המועמדים", so visiting `/employer` alone doesn't mark anything.
- **Hand-overs and limits:** the list goes through `peopleHandover` (budget `employerPeople`: 200 people/day, alert at
  100), each CV through `cvHandover` (`employerCvs`: 30/day, alert at 15); the strict entry with the candidate ids is
  written before the answer leaves; 429 at the limit + alert to admins; employers' limits are never raised. Admins see
  "which employer saw which candidate" in the activity log (search by the candidate's id or email: `employer.*` entries
  with actor `user:<employer id>`), and today's employer usage on the security screen.
- **Staff screens:** `/users-management` → "העברת מועמדויות למעסיקים" (filter "ממתינות להעברה" / "הועברו" / "הכול",
  grouped by employer and job, through `peopleHandover`); the quick-applications table has a column with the forward
  state and the two buttons for jobs of employer accounts. (A registered candidate's applications modal on the
  candidates table is unchanged: forwards of registered applications are made from the new section.)

## Logged actions

`employer.applicant_forwarded`, `employer.forward_cancelled`, `employer.forward_cancel_refused`,
`employer.applicants_shown`, `employer.cv_opened` (applicants, above),
`settings.employer_posting_updated`, `auth.signup_employer`, `employer.profile_updated`, `employer.submissions_claimed`,
`jobs.edit_requested`, `jobs.edit_withdrawn`, `jobs.edit_requests_listed`, `jobs.edit_request_viewed`,
`jobs.edit_request_approved`, `jobs.edit_request_rejected` — see the table in `docs/security.md`.
