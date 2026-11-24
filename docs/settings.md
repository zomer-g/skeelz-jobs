# The settings screen (`/settings`, "הגדרות")

Owner, 23.11.2026: "לרכז את כל הקונפיגורציות שיש, ברמת טופס הרשמה, טופס משרה, והגשה למסך ייעודי. גם בטופס הרשמה מועמדים
לאפשר הוספה של ערכים וגם בטופס משרה לאפשר הוספה של ערכים, והכל דרך מסך ייעודי ולא בתוך מסך משרות, מסך מועמדים וכו'.
שכל מנהלי התוכן יהיו רשאים לזה."

**Who:** content managers and admins (`CONTENT_ROLES`; server `contentManagerOnly`, client guard on `/settings`, header link
"הגדרות"). Placement coordinators don't open it. Every change is in the activity log.

## What is on it

| Section | Setting | Stored in | API (all `contentManagerOnly` unless noted) | Was on |
|---|---|---|---|---|
| טופס הרשמה | Which built-in fields are required / optional (ID number also "not asked") | `app_settings.signupFields` | `GET/PUT /api/admin/settings/signup-fields` | `/users-management` (bottom card) |
| טופס הרשמה | Added questions ("שאלות נוספות בהרשמה") | `custom_fields` (form `signup`), answers `users.custom_fields` | `GET/POST/PATCH /api/admin/settings/custom-fields` | new |
| טופס משרה | Added job fields ("שדות נוספים במשרה") | `custom_fields` (form `job`), answers `jobs.custom_fields` | same | new |
| הגשה | Ways to apply: guest mode (self / quick / none), CV on a quick and on a regular application | `app_settings.applyPolicy` | `GET` (`staffViewers`, the jobs table shows the defaults) / `PUT /api/admin/settings/apply-policy` | jobs-management "הגדרות הגשה" dialog (the button was removed from `/jobs-management`, owner 23.11.2026) |
| טופס משרה ופרסום משרות | Employer job posting (open / account required) — its own card and save button, `#settings-posting` (owner, 23.11.2026: it belongs to job posting, not to applying) | `app_settings.employerPosting` | `GET/PUT /api/admin/settings/employer-posting` | same dialog, then the applying card |

**Left where they are, on purpose:**
- **Per-job values** — the threshold condition (תנאי סף) and a job's own apply overrides are part of each job (job form /
  jobs table), not site settings. A coordinator still can't set them (`restrictedChanges`, 403 `content_manager_required`).
- **Security, Salesforce, API keys, staff users, the activity log** — admin-only (`/security-management`,
  `/staff-management`). The owner's rule covers the forms and applying, not these.
- **Environment switches** (`ENABLE_*`, `SEND_EMAIL_ENABLED`, `EMAIL_CODE_SIGNIN_ENABLED`, `GTM_ID`, `LEGACY_*_MODE`) — the
  owner's, on the server; never a screen.

Every save button on the screen is the same (`settings/SaveButton.tsx`: the staff screens' primary pill with a check
icon; disabled = faded). Each card saves on its own.

## Added fields (שדות נוספים) — design

**Custom fields, not new options in the fixed lists.** The fixed lists — job scope (`PTime_cambium__c`), skills
(`PSkills_cambium__c`), gender — are written as-is to Salesforce and its existing Position record type ("no new job fields").
A new option there would land in a picklist that doesn't know it. So content managers add **their own fields**:

- **Definition** (`custom_fields`): label (2–80), type `text` (up to 500 characters) / `select` (2–30 options, each up to
  80) / `checkbox` ("yes"), required or optional, order, active, a short hint, and for job fields "show on the job page".
  At most 30 per form. Pure rules: `server/src/models/schemas/customFields.ts` (`checkDefinition`, `checkCustomValues`),
  unit-tested in `server/test/customFields.test.mjs`.
- **Never deleted.** A field is turned off (`active = false`): not asked, not accepted, its answers kept and still shown
  to staff (marked "שדה כבוי"). A DB trigger refuses `DELETE`. The type is chosen once (answers were given for it).
- **Answers** are stored by the field's id (renaming a label keeps them): `users.custom_fields` / `jobs.custom_fields`
  (jsonb). A required field is enforced by the server on every sign-up (Google, Microsoft, email code), in
  `PATCH /users/me` (can't be cleared) and on a new job from the staff form (`POST /jobs`); an edit checks what it sends.
  A required checkbox must be ticked. An active required sign-up question a candidate hasn't answered makes
  `profileIncomplete` true, so they are asked once to complete their details (same as the built-in fields setting).
- **Where they show:**
  - Sign-up form and the personal area (`GET /api/custom-fields/signup`, public: active definitions only, never an answer).
  - Staff candidates list (`GET /api/users`, through `peopleHandover`: daily limit, strict log, alerts) — "פרטים נוספים".
  - Staff job form (`GET /api/admin/job-fields`, `staffViewers`: coordinators fill them too).
  - The job page, the public API and the MCP server: only ACTIVE job fields marked "show on the job page", label + value,
    plain text (`rowToJob` `extraFields` → `toPublicJob` `extraFields`; owner, 23.11.2026).
  - The employer form (`/post-job`) and employers' edit requests (owner, 23.11.2026): the active job fields, from the public
    `GET /api/custom-fields/job` (definitions only), with the same rules — required ones on a new submission, an edit
    request asks only for changed answers and a required one can't be cleared. Since 24.11.2026 (owner: "every field")
    an edit request covers EVERY active job field: those shown on the job page are shown back with their answer; the
    staff-only ones are **write-only** for the employer — asked, never shown back (staff may keep notes there), never
    compared with the stored answer (so the reply tells nothing about it), not required, and an empty answer means
    "leave it as it is"; no base value of theirs is kept in the request (the employer reads their requests back). A submission keeps its answers
    (`job_submissions.custom_fields`) until it is approved, then they go to the job (fields turned off or options removed
    in between are dropped). An edit request stays pending until a coordinator or content manager approves it, like every
    other change; staff see the answers with their labels in both review screens.
- **Never:** a candidate's answers to employers (forwarded applicants stay name + CV), to analytics, or into a log; the
  staff-only job fields (not marked "show on the job page") to the public or an employer.
- **Log** (field names only, never an answer): `settings.custom_field_created` / `settings.custom_field_updated`
  (field id, form, the names of the definition keys that changed, the label); a candidate's answers appear in
  `auth.*signup*` / `user.profile_updated` as `customFields.<id>` names; a job's in `job.created` / `job.updated`.
- **Salesforce** (owner, 23.11.2026) — nothing is sent until a matching field exists in Salesforce AND an admin linked it:
  - Each added field has an optional link (`custom_fields.sf_field`): a custom field API name (`…__c`) on **Contact** for a
    sign-up question, on the **Position Case** for a job field. The site never creates, changes or deletes a field in
    Salesforce (jobs keep the existing Position record type; a job field goes there only to a field the owner created
    and linked). Fields the site already writes, its lookup fields and the Beta checkbox can't be linked
    (`sf_field_reserved`); two fields of one form can't share one (`sf_field_taken`).
  - Linking is admin-only (`GET /admin/security/salesforce/custom-fields`, `PUT …/:id { sfField }`, logged as
    `salesforce.custom_field_linked` with the field id and API names). On `/settings` an admin sees a "Salesforce" button
    per field; content managers see the state.
  - A linked field is sent only when describe (read-only) shows it exists, is creatable + editable by the integration user,
    and fits the type: text → Text / Long Text Area, list → Picklist (the same option values) or Text, checkbox →
    Checkbox. Otherwise it is skipped and the rest of the record still goes (`salesforceUtils.customFieldsForSalesforce`).
    An unanswered field is sent empty (a checkbox false), so clearing it clears it there. Active fields only.
  - Sending goes only through the queue (`queueSalesforce`) with the candidate's Contact / the job's Case; the Beta mark
    rules are unchanged. No backlog: answers given earlier go with the next update of each record. On an adopted Contact
    (the existing site's) a linked field is filled only where it is empty, like the ID number.
  - `/settings` shows "לא נשלח ל-Salesforce עד שייווצר ויקושר שדה מתאים" on every active field that is not sent (with the
    reason when it is linked), and a summary at the top of the form's section while any is. The connection check lists
    them (`custom_fields`, a warning). The link screen re-reads the org (the server keeps describes in memory, so after
    creating a field in Salesforce, link it — or press "קישור ובדיקה" again — to have it picked up).
- **Privacy text:** "the form may ask additional questions the staff added, to match you to jobs; staff see the answers;
  some go to our contact-management system too; they don't reach employers" (`PrivacyPage.tsx`, `privacyTexts.ts`;
  version `2026-11-24`, owner's decision after the security review of 24.11.2026).

## Sign-up questions need an admin (owner, 24.11.2026; security review M6)

A question on the sign-up form may touch sensitive information (health or disability, religion, origin, political
views, sexual orientation, a criminal record, money or family matters). Such a question raises the protection the
database needs, so it must never slip in:
- The settings screen shows a warning against such topics on the sign-up section and in the add / edit dialog.
- **A content manager's new sign-up question is saved OFF**, marked "ממתין לאישור מנהל/ת מערכת" (`awaitingAdmin` in the
  answer; `custom_fields.approved_at` NULL). **Only an admin turns a sign-up question on** ("אישור והפעלה"; a content
  manager's `active: true` → 403 `admin_approval_required`, logged as `access.denied`). The admin's own new question is
  approved at once.
- **Rewording** (label, options, help) of a sign-up question by a content manager turns it OFF until an admin approves
  the new wording; "required", the order and turning it off stay with content managers. An admin's change is approved.
- Recorded: `approved_by` / `approved_at`, `settings.custom_field_approved` (field id and label), the created / updated
  entries carry `awaiting_admin`. Questions that were on before this rule count as approved (`system:existing`).
- Job fields are unchanged (they describe the job, not the person).

## Owner's decisions (23.11.2026)

- Employer form and edit requests carry the added job fields: **yes** (above).
- Public API / MCP carry the job fields shown on the job page: **yes** (`extraFields`).
- Staff editing a candidate's answers: **no** (`PATCH /users/:id` changes the built-in fields only).
- Salesforce: **yes, per field, once a matching field is created and linked** (above).

Tests: `server/test/customFields.test.mjs` (unit), `server/test/e2e-settings.mjs` (end to end, incl. the employer form,
edit requests and the public API), `server/test/e2e-salesforce-fields.mjs` (mock Salesforce: link, describe, sent only when
the org has the field).
