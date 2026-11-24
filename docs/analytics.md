# Analytics — GA4 + Google Tag Manager (funnel to the forms)

Off by default (owner rule, `CLAUDE.md`). Nothing loads and nothing is sent unless the owner sets `GTM_ID`
(`GTM-…`) and/or `GA_ID` (`G-…`) on the server, and then nothing is measured until the visitor accepts in the
cookie banner. `launch.sh` forces both empty unless set.

| Piece | Where |
|---|---|
| Allowlist of events, parameter keys and value checks (pure, unit-tested) | `client/src/utils/analyticsPolicy.ts` |
| Runtime helper: `track()`, `trackOnce()`, SPA `page_view`, consent | `client/src/utils/analytics.ts` |
| Notice (he/en, RTL): data collection + Google Analytics cookies, "הבנתי" | `client/src/components/consent/NoticeBanner.tsx` |
| Consent Mode v2 defaults, GTM / gtag loaders (CSP nonce) | `server/src/index.ts` (`consentSnippet`, `analyticsSnippet`) |
| Test: no personal data, docs/server/client agree | `server/test/analytics.test.ts` (part of `npm test`) |
| Importable GTM container (generated from the allowlist) | `docs/analytics/gtm-container.json` (`build-gtm-container.ts`) |

## 0. Live setup (created 11.11.2026 in the browser, Google account owner@example.com)

| What | Value |
|---|---|
| GA4 account / property | `SKEELZ` (a415942930) / `SKEELZ Jobs (jobs.skeelz.co.il)` (p563854648), Israel time, ILS |
| Web data stream | `SKEELZ Jobs web`, https://jobs.skeelz.co.il, stream 16323333057 |
| **GA4 measurement ID** | **`G-RPMX021BL3`** |
| GTM account / container | `SKEELZ` (6404396456) / `jobs.skeelz.co.il` (286435502) |
| **GTM_ID for the server** | **`GTM-WXQW5LTX`** — published version 2 = `gtm-container.json` with the real G- ID |
| Google tag (auto-created by GA) | `GTM-WH6ZSNMT` — **not** installed on the site; holds the tag settings below |

Done: terms accepted for Israel (Google Ireland); all account data-sharing boxes off; enhanced measurement only page
loads, scrolls, outbound clicks, video (history page views, site search, form interactions, file downloads off);
redaction: emails + query params `token, searchValue, email`; event and user data retention 14 months; Google
signals / user-provided data off; 12 custom dimensions + 5 custom metrics (§5); **cookie expiry 13 months set in the
Google tag settings (GTM-WH6ZSNMT → Settings → Override cookie settings), because the `cookie_expires` parameter in
the GTM tag alone was not applied** (verified locally: `_ga` 395 days).
Verified end to end with `GTM_ID=GTM-WXQW5LTX` on a local server: no Google request before consent; after accepting,
gtm.js → gtag.js → `g/collect?tid=G-RPMX021BL3`. (A few localhost test hits are in the property, utm_source=e2e_test.)

Still to do (owner):
1. Set `GTM_ID=GTM-WXQW5LTX` on xhostd after this branch is merged (leave `GA_ID` empty — GTM loads GA).
2. After the first real events arrive (within ~24 h), GA4 → Admin → Events → mark `apply_success`, `post_job_success`,
   `sign_up` as key events (star). GA4 only lets you star events it has received. The objective wizard pre-created
   `close_convert_lead` / `qualify_lead` key events; they are unused and can be unstarred.
3. Optionally add SKEELZ staff as users (GA account and GTM account → User management) and move ownership.

## 1. Privacy rules (enforced in code)

**Never sent to Google:** names, emails, phone numbers, CV files or file names, anything typed in a form or the
search box, map coordinates or the chosen town, tokens (password reset), passwords, IP addresses we know of.

How the code enforces it:

- `buildEvent()` drops any event that is not in `EVENTS`, any key not listed for that event, and any value that fails
  its check (`PARAM_CHECKS`): enums are enums, numbers are bounded integers, `job_id` must be a 24-hex ObjectId,
  `field_name` must be one of the known form field **names**, `error_code` must be an enum key (`UPPER_SNAKE`) or
  one of the employer form's codes (`required`, `too_short`, …). Emails, 7+ digit runs, spaces and Hebrew are
  rejected in every free-ish value (UTM, URLs).
- URLs are cleaned before they reach Google: `page_location` = origin + path + only `utm_*` and `view`
  (`?searchValue=` free text and `?token=` are removed; odd path segments become `:redacted`); `page_referrer` =
  origin only. The GA4 tag is told to use these instead of `document.location` (see §4).
- Error messages are mapped back to their i18n enum key (`errorCode()`), never sent as text.
- Components never call `dataLayer.push` / `gtag` directly — only `track()`. The test fails otherwise.
- **UTM rule for campaigns (SMOOV etc.):** never put merge tags (recipient name, email, id) into `utm_*`. A plain
  label like `newsletter_nov` cannot be told apart from a name by its shape. Emails/phones/Hebrew are dropped anyway.

## 2. Notice, not consent (since 16.11.2026)

The owner decided (15.11.2026) that measurement needs no opt-in: a notice says so and the visitor closes it.
- The server writes `gtag('consent','default', {analytics_storage: 'granted', ad_storage, ad_user_data,
  ad_personalization: 'denied'})`, `ads_data_redaction`, then calls `window.__skeelzLoadAnalytics()` (defined in the
  same inline script, carries the CSP nonce), which injects gtm.js / gtag.js on page load.
- The notice (`client/src/components/consent/NoticeBanner.tsx`): the data-collection sentence plus one sentence on
  Google Analytics cookies, a link to `/privacy` and "הבנתי" (remembered in `localStorage` `skeelz_notice_v2`).
  There is no consent banner and no footer "cookie settings" link any more; the privacy page tells people how to
  opt out (block cookies in the browser, or Google's opt-out add-on).
- **Ads are never granted** — the site runs no ads. If the owner ever adds Google Ads / Meta tags, that needs a
  consent step and a privacy-text update first.
- GA cookies `_ga`, `_ga_<id>`: **13 months** (`cookie_expires` = 34128000 s, `GA_COOKIE_EXPIRES_SECONDS`), set in
  the Google tag (GTM) / gtag config. The privacy page states it.
- What may be sent is unchanged: the allowlist in `analyticsPolicy.ts` (no names, emails, phones, CVs or typed text).

## 3. Event plan

Every event also carries the context keys: `page_path`, `page_location`, `page_referrer`, `language` (`he`/`en`) and
the first-touch `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` (kept for the session).

### Candidates

| Event | When | Parameters | Call site |
|---|---|---|---|
| `page_view` | Every route change (React Router) and right after consent | context only | `App.tsx` `<PageViews/>` → `usePageViews()` |
| `job_list_view` | Job list shown (once per load) | `view`, `results_count` | `Jobs/Jobs.tsx` |
| `job_search` | Search text and/or filters applied | `has_search_text` (bool, never the text), `filter_count`, `filter_scope_count`, `filter_location_count`, `filter_skill_count`, `results_count` | `header/Header.tsx` `fetchJobs` |
| `view_switch` | List ⇄ map | `view` | `Jobs/Jobs.tsx` |
| `map_search` | Map results loaded | `radius_km`, `map_point_source` (`city`/`map`/`geo`), `results_count`, `filter_count` — **no coordinates, no town** | `Jobs/MapJobSearch.tsx` |
| `job_view` | Job opened (card modal or `/job/:id`), once per job per load | `job_id`, `source` (`list`/`direct`), `apply_type` | `jobcard/ExtendedJobCard.tsx` |
| `apply_click` | "Apply" pressed | `job_id`, `apply_type` (`guest`/`registered`/`self_apply`) | `jobcard/ApplyJobButtons.tsx` |
| `login_prompt` | Apply needs login (guest on a register-only job, existing email, signed-out "apply") | `job_id`, `source=apply` | `ApplyJobButtons.tsx`, `ExtendedJobCard.tsx` |
| `apply_form_shown` | Guest form or signed-in CV step shown (once per job) | `job_id`, `apply_type`, `cv_required` | `GuestApplyModal.tsx`, `jobcard/ApplyWithCvDialog.tsx` |
| `apply_validation_error` | Guest form submitted with errors, one per field | `job_id`, `apply_type`, `field_name` (`fullName`/`email`/`phoneNumber`/`cvFilePath`), `error_code` (`required`/`invalid`) | `GuestApplyModal.tsx` |
| `apply_start` … `apply_abandon` | The apply funnel, step by step — see **§3a** | flow keys + `step`, `step_name` | `utils/applyFlow.ts` |
| `login` | Logged in (code by email, or back from "Continue with Google / Microsoft") | `method` (`email_code`/`google`/`microsoft`), `source` (`apply` if it came from an apply button in the last 30 min, else `header`), `job_id` | `login/LoginModal.tsx`, `utils/signIn.ts` (SSO: the server adds `?via=google|microsoft` to the redirect back) |
| `sign_up_start` | Registration form opened | `source`, `job_id` | `register/RegisterUser.tsx` |
| `sign_up` | Registered — **key event** | `method` (`email_code`/`google`/`microsoft`), `source`, `job_id` | `register/RegisterUser.tsx`, `register/SignUpChooser.tsx` (employer) |

### Employers (public `/post-job`)

All wired in `client/src/components/employer/PostJobPage.tsx` (§7 lists the exact call sites).

| Event | When | Parameters |
|---|---|---|
| `post_job_view` | `/post-job` shown | context only |
| `post_job_start` | First focus on any field (once per load) | `field_name` |
| `post_job_step` | First focus inside a section: 1 `job`, 2 `apply`, 3 `contact`, 4 `consent` (once each) | `step`, `step_name` |
| `post_job_validation_error` | Submit with errors (client or server 400), one per field | `field_name`, `step`, `error_code` (`required`/`too_short`/`too_long`/`invalid`) |
| `post_job_submit` | Valid form sent | — |
| `post_job_success` | Server accepted (pending review) — **key event** | — |
| `post_job_error` | 429 / 503 / other / network | `error_code` (`rate_limited`/`queue_full`/`server_error`/`network`) |

### Staff (jobs-management screen)

| Event | When | Parameters | Call site |
|---|---|---|---|
| `job_publish` | A content manager / admin created a job (server accepted it) | `job_id` only | `CreateOrEditJobContainer.tsx` |

### Other

| Event | When | Parameters |
|---|---|---|
| `consent_update` | Visitor accepted measurement | `consent_analytics=true` |
| `pwa_install_prompt` | "התקנת האפליקציה" used (footer or phone menu, `components/pwa/InstallApp.tsx`): the browser's install dialog was answered, or the iPhone how-to opened | `install_source` (`footer`/`menu`), `install_outcome` (`accepted`/`dismissed`/`ios_help`) |
| `pwa_installed` | The browser reports the site was installed (`appinstalled`, `utils/pwa.ts`; not fired on iPhone, Safari does not tell) | — |

Funnels to build in GA4 → Explore → Funnel exploration:
- **Candidate (to the job):** `job_list_view` → `job_view` → `apply_click` → then the apply funnel (§3a).
- **Apply funnel / abandonment:** §3a.
- **Employer:** `post_job_view` → `post_job_start` → `post_job_step` (step 3) → `post_job_submit` → `post_job_success`.

### 3a. The apply funnel (CV on apply, threshold condition, abandonment)

One **attempt** = one open flow per application (`client/src/utils/applyFlow.ts`, one instance in `analytics.ts`).
It covers every way of applying: **quick** (guest form), **regular** (signed in, CV dialog) and **self** ("I'll apply
to the employer myself"), with and without a CV requirement, with and without a threshold condition. Every event of
an attempt carries the same keys, so any step can be broken down by them:

| Key | Values |
|---|---|
| `job_id` | the job (24-hex id) |
| `apply_type` | `guest` / `registered` / `self_apply` |
| `apply_mode` | `quick` / `regular` / `self` |
| `cv_required` | the job's CV rule for this way of applying (`true` = a CV must be attached) — the CV step's *reason* |
| `has_threshold` | the job has a threshold condition (**never its text**) |
| `cv_choice` | once chosen: `profile` (the CV on the profile) / `updated` (new file replaces it) / `job_only` / `none` |
| `step`, `step_name` | the funnel step (numbers below) |

| # | `step_name` | Event(s) | When | Call site |
|---|---|---|---|---|
| 1 | `start` | `apply_start` | Signed in: "apply" pressed (before the CV dialog). Guest: first focus in the guest form, or "apply" pressed. Self: "I'll apply myself" | `ApplyJobButtons.tsx`, `GuestApplyModal.tsx` / `startGuestApply()`, `JobCard.tsx` |
| 2 | `cv_step` | `apply_cv_step` | The CV step is shown (signed in: profile CV / upload; guest: the form with its CV field). `cv_required` = why | `ApplyWithCvDialog.tsx`, `startGuestApply()` |
| 3 | `cv_upload` | `apply_cv_upload_start`, `apply_cv_upload` (`file_type`, `file_size_kb` — never the name), `apply_cv_upload_error` (`error_code`: `UNSUPPORTED_TYPE`, `FILE_TOO_LARGE`, `FILE_NAME_TOO_LONG`, `FILE_NAME_INVALID`, `UPLOAD_FAILED`) | A file is uploaded | `ApplyWithCvDialog.tsx`, `common/SmallUploadFileArea.tsx` (guest) |
| 4 | `cv_choice` | `apply_cv_choice` | The CV for this application is decided (sets `cv_choice` for the rest of the attempt) | `ApplyWithCvDialog.tsx`, `ExtendedJobCard.tsx` (guest), `JobCard.tsx` (self: `none`) |
| 5 | `threshold` | `apply_threshold_shown`, `apply_threshold_dismissed` | The threshold-condition dialog opened / was closed without confirming (the attempt stays open) | `Job.service.ts` `confirmThreshold` |
| 6 | `threshold_confirmed` | `apply_threshold_confirmed` | Box ticked and confirmed | same |
| 7 | `terms` | `apply_terms_shown`, `apply_terms_declined` | Signed in, terms not accepted / marketing never answered: the one-time question | `Job.service.ts` `applyJob` |
| 8 | `submit` | `apply_submit`; `apply_error` (`error_code`) | The request is sent; refused (the attempt stays open — they can fix it and retry) | `Job.service.ts` `sendApplication` |
| 9 | `success` | `apply_success` — **key event** | The server accepted it; the attempt ends | same |
| — | furthest step | `apply_abandon` (`abandon_reason`: `dialog_closed` / `page_left` / `other_job`) | Ended without success: CV dialog or job window closed, tab closed / navigated away, or an attempt at another job began | `ApplyWithCvDialog.tsx` (regular), `ExtendedJobCard.tsx` (quick), `analytics.ts` (`beforeunload`/`pagehide`) |

Steps a job doesn't have are skipped (no threshold → no 5–6; terms already accepted → no 7). `apply_abandon`
carries `step`/`step_name` of the **furthest step reached** plus all the keys above, so "left when a CV was required"
is `apply_abandon` with `step_name = cv_step` and `cv_required = true`, and "left at the threshold dialog" is
`step_name = threshold`. `page_left` is best effort (the browser may not send an event while closing the tab).

`error_code` on `apply_error` is the server's code, never its message: `threshold_not_confirmed`, `cv_required`
(`jb11`), `already_applied` (`jb3`), `apply_failed` (`jb4`), `candidate_read_only`, `job_on_existing_site`, `consent_needed`,
`terms_not_accepted`, `employer_account`, `limit_reached` (`limit_*`), `network`, or another internal code (`jb7`).
The client keeps the last API error code in `utils/lastApiError.ts` (set by `GlobalApi.generalRequest`).

**Renamed / changed (20.11.2026):** `cv_upload` → `apply_cv_upload`, `cv_upload_error` → `apply_cv_upload_error`;
`cv_choice` values `keep`/`replace` → `profile`/`updated`; `apply_submit` / `apply_success` / `apply_error` are now
recorded once in `JobService` for every way of applying (they were in three components) and carry the flow keys.

#### Build the abandonment funnel in GA4 (Explore → Funnel exploration)

1. **Custom definitions first** (Admin → Custom definitions → Create custom dimension, scope *Event*, parameter =
   name): `apply_mode`, `has_threshold`, `abandon_reason`. Already registered: `job_id`, `apply_type`, `cv_choice`,
   `cv_required`, `step_name`, `error_code`, `file_type`, `source`, `field_name`, `view`, `map_point_source`,
   `has_search_text`; metric `step`. (Data before a definition existed is not shown under it.)
2. New exploration → **Funnel exploration**. Steps (each "Event name ="): `apply_start` → `apply_cv_step` →
   `apply_cv_choice` → `apply_submit` → `apply_success`. Optional extra step between `apply_cv_choice` and
   `apply_submit`: `apply_threshold_shown` (only jobs with a condition reach it — use it in a separate funnel with the
   segment below). *Open funnel* off (everyone starts at `apply_start`).
3. **Breakdown:** `apply_mode`, then `cv_required` (CV required vs optional), then `has_threshold`.
4. Turn on **Show elapsed time** and use **Next action** on a step to see `apply_abandon` / `apply_error` after it.
5. **Abandonment by step:** Free-form exploration, rows `step_name`, columns `abandon_reason`, value *Event count*,
   filter Event name = `apply_abandon`. Add `cv_required` / `has_threshold` as rows to compare.
   - "Left when a CV upload was required": filter `step_name` = `cv_step` or `cv_upload` and `cv_required` = `true`.
   - "Left when the threshold dialog appeared": filter `step_name` = `threshold` (dismissed) — compare with the count
     of `apply_threshold_shown` / `apply_threshold_confirmed`.
6. **Why applications were refused:** Free-form, rows `error_code`, filter Event name = `apply_error`.
7. Segments worth saving: *Jobs with a threshold* (event param `has_threshold` = true), *Guest quick apply*
   (`apply_mode` = `quick`), *CV required* (`cv_required` = true).

## 4. GTM container setup

**Updating the live container (GTM-WXQW5LTX) after a change to the allowlist** — e.g. the apply funnel of 20.11.2026.
Signed in to Google as the account that owns it (owner@example.com — never the GUY@SKEELZ account of the old site):
1. tagmanager.google.com → account **SKEELZ** → container **jobs.skeelz.co.il** (GTM-WXQW5LTX).
2. **Admin** → **Import Container** → *Choose container file*: `docs/analytics/gtm-container.skeelz-live.json` (the same
   container as `gtm-container.json`, with `G-RPMX021BL3` filled in).
3. *Choose workspace*: **Default Workspace**. *Import option*: **Merge** → **Overwrite conflicting tags, triggers and
   variables**. Check the preview: the trigger `CE - SKEELZ funnel events` and the tag `GA4 Event - SKEELZ funnel (all
   events)` are *Modified*, the new `DLV - apply_mode`, `DLV - has_threshold`, `DLV - abandon_reason` are *Added*,
   nothing is *Deleted*. → **Add to workspace** (or Confirm).
4. **Preview** with the site (after `GTM_ID` is set there, or a local server with `GTM_ID=GTM-WXQW5LTX`): open a job,
   apply, and see `apply_start` … `apply_success` fire the GA4 Event tag (Tag Assistant), then GA4 → DebugView.
5. **Submit** → *Publish and Create Version*, name e.g. "Apply funnel steps (20.11.2026)" → **Publish**.
6. GA4 → Admin → Custom definitions: create the three new event-scoped dimensions `apply_mode`, `has_threshold`,
   `abandon_reason` (§3a).
7. The installable app (22.11.2026, `docs/pwa.md`) added `pwa_install_prompt` / `pwa_installed`: the same import
   brings the trigger change and `DLV - install_source`, `DLV - install_outcome`; optionally add those two as
   event-scoped dimensions.

**Fast path:** GTM → Admin → Import container → `docs/analytics/gtm-container.json` → *Merge* (rename conflicts) into a
new workspace. Then open the variable **GA4 Measurement ID** and put the real `G-…`. (The file is generated by
`docs/analytics/build-gtm-container.ts`; it has not been imported into a real account from here, so if GTM rejects
it, build it by hand as below — it is three objects.)

**By hand:**

1. **Variables**
   - Constant `GA4 Measurement ID` = `G-…`.
   - Built-in `Event` (Variables → Configure → Event).
   - One **Data Layer Variable** (version 2) per key, named `DLV - <key>`: `page_path`, `page_location`,
     `page_referrer`, `language`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and every
     parameter in §3 (`job_id`, `apply_type`, `cv_choice`, `cv_required`, `source`, `view`, `results_count`,
     `has_search_text`, `filter_count`, `filter_scope_count`, `filter_location_count`, `filter_skill_count`,
     `radius_km`, `map_point_source`, `error_code`, `field_name`, `step`, `step_name`, `file_type`, `file_size_kb`,
     `method`, `consent_analytics`, `apply_mode`, `has_threshold`, `abandon_reason`, `install_source`, `install_outcome`).
2. **Trigger** `CE - SKEELZ funnel events`: Custom Event, *Use regex matching*, event name =
   `^(page_view|job_list_view|job_search|map_search|view_switch|job_view|apply_click|apply_form_shown|apply_validation_error|apply_start|apply_cv_step|apply_cv_upload_start|apply_cv_upload|apply_cv_upload_error|apply_cv_choice|apply_threshold_shown|apply_threshold_confirmed|apply_threshold_dismissed|apply_terms_shown|apply_terms_declined|apply_submit|apply_success|apply_error|apply_abandon|login_prompt|login|sign_up_start|sign_up|post_job_view|post_job_start|post_job_step|post_job_validation_error|post_job_submit|post_job_success|post_job_error|job_publish|consent_update|pwa_install_prompt|pwa_installed)$`.
   (You may instead create one Custom Event trigger + one GA4 Event tag per event; the single regex trigger and tag
   below send exactly the same thing with less to maintain.)
3. **Tag** `Google tag - GA4 (SKEELZ)` (type *Google tag*): Tag ID `{{GA4 Measurement ID}}`; Configuration parameters
   `send_page_view` = `false`, `cookie_expires` = `34128000` (13 months — stated on /privacy),
   `page_location` = `{{DLV - page_location}}`, `page_referrer` = `{{DLV - page_referrer}}`.
   Triggers: *Initialization - All Pages* **and** `CE - SKEELZ funnel events`; Advanced → Tag firing options: *Once per
   page*; Consent settings → *Require additional consent* → `analytics_storage`.
   (The site pushes no events before consent, so the CE trigger is what loads the tag on a first visit.)
4. **Tag** `GA4 Event - SKEELZ funnel (all events)` (type *Google Analytics: GA4 Event*): Measurement ID
   `{{GA4 Measurement ID}}`; Event name `{{Event}}`; Event parameters: one row per DLV above (name = key, value =
   `{{DLV - key}}`), except `page_referrer`. Trigger `CE - SKEELZ funnel events`; consent: require `analytics_storage`.
5. **Do not add** History Change / All Pages GA4 page_view tags, Click/Form listeners that read element text or form
   values, or any tag without the `analytics_storage` requirement. Any new tag must pass the rules in §1.
6. Preview → verify (§6) → Submit / Publish.

The server already allows `googletagmanager.com` / `google-analytics.com` in the CSP and passes the nonce to gtm.js.
GTM *Custom HTML* tags would need `'unsafe-inline'` / the nonce — don't use them.

## 5. GA4 property settings

- **Data stream → Enhanced measurement:** keep *Page views* but turn **off** "Page changes based on browser history
  events" (the site sends `page_view` itself with clean URLs), **off** *Form interactions*, **off** *Site search*,
  **off** *File downloads* (CV links). Scrolls / outbound clicks may stay.
- **Data stream → Redact data:** enable email redaction; query parameters to redact: `token, searchValue, email`.
- **Admin → Data collection:** Google signals **off**; granular location & device data — off if you don't need it.
- **Data retention: set event data retention to 14 months** (Admin → Data collection and modification → Data
  retention; "Reset user data on new activity" on). `/privacy` says 14 months (`GA_RETENTION_MONTHS`) — change both
  together. Don't enable User-ID.
- **Custom definitions** (event-scoped dimensions): `job_id`, `apply_type`, `cv_choice`, `source`, `view`,
  `map_point_source`, `error_code`, `field_name`, `step_name`, `file_type`, `has_search_text`, `cv_required`,
  `language`. Custom metrics: `results_count`, `radius_km`, `filter_count`, `step`, `file_size_kb`.
- **Key events (conversions):** `apply_success`, `post_job_success`, `sign_up`
  (`KEY_EVENTS` in `analyticsPolicy.ts`). Optionally `apply_click` as a micro-conversion.
- Link Search Console if wanted; do **not** link Google Ads unless the banner gets a marketing category first.

## 6. Verify

Locally (what was done for this change):

```bash
cd server && npx tsc && npm test
```

```bash
cd client && npm run build
```

Start the server with a test container id (any well-formed id; e.g. `GTM_ID=GTM-TEST123`), open the site, and in the
browser console:

```js
window.__ANALYTICS__        // {gtm: true, ga: false}
window.dataLayer            // consent default (arguments), gtm.js … and NO funnel events yet
// click "מאשר/ת מדידה", open a job, press apply …
window.dataLayer.filter(e => e.event && !String(e.event).startsWith('gtm.'))
```

Every funnel object must contain only keys from `PARAM_CHECKS` (others are `undefined` resets) and no personal value.

With a real container: GTM **Preview** (Tag Assistant, tagassistant.google.com) → check that the Google tag and the
GA4 Event tag fire only after consent, the *Consent* tab shows `analytics_storage: granted` after accepting, and the
*Variables* tab shows cleaned `page_location`. Then GA4 → Admin → **DebugView** (Preview sessions appear there) and
Realtime. Test with the banner rejected too: no GA4 requests (`collect?v=2`) in the Network tab.

## 7. Employer form — call sites

The employer form was merged into `master` while this work was in progress, so these are wired (not a to-do).
If the form is rewritten, keep the same calls. All in `client/src/components/employer/PostJobPage.tsx`. Imports:
`import { track, trackOnce } from '../../utils/analytics';` and `import { postJobStepOf } from '../../utils/analyticsPolicy';`

1. **`post_job_view`** — mount effect: `trackOnce('post_job_view', 'post_job_view');`
2. **`post_job_start` / `post_job_step`** — `onFocusCapture={onFieldFocus}` on the `<form>`: the field name is taken
   from the focused element's id (`post-job-jobScope-3` → `jobScope`); unknown ids (the honeypot) are ignored;
   `trackOnce` for the first field and for each section (`postJobStepOf`).
3. **`post_job_validation_error`** — `trackErrors(e)` after `validate(…)` fails, and `trackErrors(body.fields)` on a
   server 400: one event per field with its code (`required`/`too_short`/`too_long`/`invalid`) and step.
4. **`post_job_submit`** — just before `fetch('/api/job-submissions', …)`: `track('post_job_submit');`
5. **`post_job_success`** — in `if (res.ok) { … }`: `track('post_job_success');`
6. **`post_job_error`** — in the `else` branch: `track('post_job_error', { error_code: res.status === 429 ? 'rate_limited' : res.status === 503 ? 'queue_full' : 'server_error' });`
   and in `catch`: `track('post_job_error', { error_code: 'network' });`
7. If the field list changes, update `POST_JOB_FIELDS` / `postJobStepOf` in `analyticsPolicy.ts` (the test checks
   that only listed field names pass). Never send `values`, the honeypot, or the server's error text.
8. Footer: the "הגדרות עוגיות" button sits under "מדיניות פרטיות" (4 columns since the employer link was added).

## 8. Adding an event

1. Add it to `EVENTS` (and any new key to `PARAM_CHECKS` with a strict check) in `analyticsPolicy.ts`.
2. Call `track('<name>', {...})` from the component — never `dataLayer.push`.
3. Document it in §3 (the test fails if an event is missing here), regenerate the container
   (`cd server && npx tsx ../docs/analytics/build-gtm-container.ts`), add the name to the GTM trigger regex.
4. If it reveals something new about people, update `PrivacyPage.tsx` and `docs/privacy/*.md` in the same change.
