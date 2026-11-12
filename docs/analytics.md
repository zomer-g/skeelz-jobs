# Analytics — GA4 + Google Tag Manager (funnel to the forms)

Off by default (owner rule, `CLAUDE.md`). Nothing loads and nothing is sent unless the owner sets `GTM_ID`
(`GTM-…`) and/or `GA_ID` (`G-…`) on the server, and then nothing is measured until the visitor accepts in the
cookie banner. `launch.sh` forces both empty unless set.

| Piece | Where |
|---|---|
| Allowlist of events, parameter keys and value checks (pure, unit-tested) | `client/src/utils/analyticsPolicy.ts` |
| Runtime helper: `track()`, `trackOnce()`, SPA `page_view`, consent | `client/src/utils/analytics.ts` |
| Consent banner (he/en, RTL) + footer "הגדרות עוגיות" | `client/src/components/consent/ConsentBanner.tsx`, `footer/Footer.tsx` |
| Consent Mode v2 defaults, GTM / gtag loaders (CSP nonce) | `server/src/index.ts` (`consentSnippet`, `analyticsSnippet`) |
| Test: no personal data, docs/server/client agree | `server/test/analytics.test.ts` (part of `npm test`) |
| Importable GTM container (generated from the allowlist) | `docs/analytics/gtm-container.json` (`build-gtm-container.ts`) |

## 0. Live setup (created 11.11.2026 in the browser)

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

## 2. Consent (Google Consent Mode v2)

- **Nothing from Google loads before consent.** The server writes `gtag('consent','default', {analytics_storage, ad_storage, ad_user_data,
  ad_personalization: 'denied'})`, `ads_data_redaction`, and re-applies a stored "accept" (`localStorage`
  `skeelz_consent_v1`, max 365 days → the banner asks again).
- Banner: "מאשר/ת מדידה" / "לא, תודה" (equal buttons), link to `/privacy`. Not a modal; a labelled region.
  Footer "הגדרות עוגיות" reopens it (only when analytics is on). The choice → `gtag('consent','update', …)`.
- **Ads are never granted** — the site runs no ads. If the owner ever adds Google Ads / Meta tags, add a
  marketing category to the banner and update the privacy texts first.
- gtm.js / gtag.js are injected only by `window.__skeelzLoadAnalytics()` (defined in the same inline script, carries
  the CSP nonce): immediately when a stored "accept" exists, otherwise when the visitor presses accept. Rejecting
  later sends `consent update: denied` and deletes the `_ga` / `_ga_<id>` cookies (they stay loaded for that page).
- GA cookies `_ga`, `_ga_<id>`: **13 months** (`cookie_expires` = 34128000 s, `GA_COOKIE_EXPIRES_SECONDS`), set in
  the Google tag (GTM) / gtag config. The privacy page states it.
- Defence in depth: `track()` sends nothing without analytics consent (so events never reach the dataLayer before
  consent), and every Google tag in GTM requires `analytics_storage` (basic consent mode). After accepting, a
  `consent_update` and a `page_view` for the current page are sent.

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
| `apply_cv_choice` | Signed-in candidate chooses the CV | `job_id`, `cv_choice` (`keep`/`replace`/`job_only`/`none`) | `ApplyWithCvDialog.tsx` |
| `cv_upload` | CV uploaded | `job_id`, `apply_type`, `file_type` (`pdf`/`docx`/`other`), `file_size_kb` — **never the name** | `ApplyWithCvDialog.tsx`, `common/SmallUploadFileArea.tsx` (guest) |
| `cv_upload_error` | Upload refused/failed | `job_id`, `apply_type`, `error_code` (`UNSUPPORTED_TYPE`, `FILE_TOO_LARGE`, `FILE_NAME_TOO_LONG`, `FILE_NAME_INVALID`, `UPLOAD_FAILED`) | same |
| `apply_validation_error` | Guest form submitted with errors, one per field | `job_id`, `apply_type`, `field_name` (`fullName`/`email`/`phoneNumber`/`cvFilePath`), `error_code` (`required`/`invalid`) | `GuestApplyModal.tsx` |
| `apply_submit` | Application sent to the server | `job_id`, `apply_type`, `cv_choice` | `ExtendedJobCard.tsx` (guest), `ApplyWithCvDialog.tsx`, `JobCard.tsx` (self-apply) |
| `apply_success` | Server accepted it — **key event** | `job_id`, `apply_type`, `cv_choice` | same |
| `apply_error` | Server refused it | `job_id`, `apply_type`, `error_code` (i18n key, e.g. `USER_ALREADY_EXISTS`) | same |
| `login` | Logged in | `method=email`, `source` (`apply` if it came from an apply button in the last 30 min, else `header`), `job_id` | `login/LoginModal.tsx` |
| `sign_up_start` | Registration form opened | `source`, `job_id` | `register/RegisterUser.tsx` |
| `sign_up` | Registered — **key event** | `method=email`, `source`, `job_id` | `register/RegisterUser.tsx` |

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

### Other

| Event | When | Parameters |
|---|---|---|
| `consent_update` | Visitor accepted measurement | `consent_analytics=true` |

Funnels to build in GA4 → Explore → Funnel exploration:
- **Candidate:** `job_list_view` → `job_view` → `apply_click` → `apply_form_shown` → `apply_submit` → `apply_success`
  (breakdown by `apply_type`, `source`, `utm_source`).
- **Employer:** `post_job_view` → `post_job_start` → `post_job_step` (step 3) → `post_job_submit` → `post_job_success`.

## 4. GTM container setup

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
     `method`, `consent_analytics`).
2. **Trigger** `CE - SKEELZ funnel events`: Custom Event, *Use regex matching*, event name =
   `^(page_view|job_list_view|job_search|map_search|view_switch|job_view|apply_click|apply_form_shown|apply_cv_choice|cv_upload|cv_upload_error|apply_validation_error|apply_submit|apply_success|apply_error|login_prompt|login|sign_up_start|sign_up|post_job_view|post_job_start|post_job_step|post_job_validation_error|post_job_submit|post_job_success|post_job_error|consent_update)$`.
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
