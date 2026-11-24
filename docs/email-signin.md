# Sign-in by a code sent by email ("קבלת קוד למייל") — and Resend

Since 11.2026 candidates have **no password**. They sign in with "Continue with Google" (xhostd SSO) or with a one-time
code sent to their email. A new address that gets a code goes on to the sign-up form, so the same button is also how a
new candidate signs up. Staff (admins, content managers) sign in **only** with Google; they never get a code.

Code: `server/src/controllers/emailSigninController.ts` (routes), `server/src/security/emailCode.ts` (numbers, hashing,
decisions), `server/src/services/emailService.ts` (Resend), `client/src/components/login/EmailCodeSignIn.tsx` (screen).
Security details: `docs/security.md` → "Sign-in". Tests: `test/unit/emailSignin.test.ts`, `test/e2e-email-signin.mjs`.

## How it works
1. The candidate types their email → `POST /api/auth/email/request`. The answer is always the same ("if this address
   can sign in here, a code is on its way"), whether or not there is an account, so nobody can find out who is
   registered. A 6-digit code is emailed to a new address or a candidate's; staff and deactivated accounts get nothing.
2. They type the code → `POST /api/auth/email/verify`. The code is valid **10 minutes**, works **once**, and allows
   **5 tries**; asking for a new code cancels the old one.
3. An existing candidate is signed in. A new address gets the sign-up form (the same details and consent boxes as
   every sign-up); the account is created only when the form is sent.

Limits: one code per address every 60 seconds, 5 an hour, 10 a day; per IP 20 requests and 60 tries per 15 minutes.
Stored: only keyed hashes of the address and the code (never either in clear), removed after a day. The activity log
records each step (`auth.email_code_*`) with `user:<id>` or a hash of the address, never the address or the code.

Existing candidates keep their accounts and sign in by code with the same email. Their old password hashes are
cleared once at deploy (migration `2026-11-clear-candidate-passwords`; only the password column changes — no account,
application or CV is touched). Sessions made with a password before the deploy keep working until they end.

## What Resend receives
Every email the site sends: the recipient's address and the message (subject, text, HTML). That is the sign-in code,
the welcome note to a new candidate, the staff invite, and the notices to the team about a new application (which hold
the candidate's name, email and phone) or a new employer job submission. The privacy page says so
(`client/src/components/privacy/PrivacyPage.tsx`, `privacyTexts.ts`). **A new kind of email, or new data in one, needs
a privacy-text update.**

Region: create the sending domain in **Ireland (eu-west-1)** — the privacy texts say emails are sent from Resend's
servers in Ireland. Resend keeps account data, email metadata and logs in the United States whatever the sending
region (Resend docs, "Domains → Regions"). If another region is chosen, change the privacy texts first.

## Owner steps (in Resend — only the owner does these)
1. **Add the sending domain.** Resend → *Domains* → *Add domain*. Use a subdomain used only for this site, e.g.
   `mail.<your domain>` (keeps the main domain's mail reputation apart). Region: **Ireland (eu-west-1)**.
2. **DNS records.** Resend shows the records to add at the domain's DNS provider — typically:
   - an **MX** record and a **TXT (SPF)** record on the `send.` sub-subdomain it names (used for bounces);
   - a **TXT (DKIM)** record `resend._domainkey…` with the public key;
   - recommended: a **TXT (DMARC)** record `_dmarc.<domain>`, e.g. `v=DMARC1; p=none;` to start.
   Copy them exactly as Resend shows them, then press *Verify* in Resend and wait until the domain shows **Verified**.
3. **API key, sending only.** Resend → *API Keys* → *Create API key*: permission **Sending access** (not Full access),
   restricted to the domain from step 1. Copy it once (`re_…`); it is not shown again.
4. **Set it on xhostd** (app `skeelz-jobs`), then deploy:

   | Name | Kind | Value |
   |---|---|---|
   | `RESEND_API_KEY` | **secret** (`set_secret`) | the `re_…` key from step 3 |
   | `EMAIL_FROM` | env (`set_env`) | `SKEELZ <no-reply@mail.your-domain>` — an address on the verified domain |
   | `SEND_EMAIL_ENABLED` | env | `true` — nothing is sent without it (codes would only be logged, without the code in production) |
   | `EMAIL_CODE_SIGNIN_ENABLED` | env | `true` — the feature switch. **Off by default**: the "קבלת קוד למייל" option is shown greyed out with "תיפתח בקרוב", and its routes answer 503 `au18` |
   | `CLIENT_BASE_URL` | env | already set; the code email names the site with it |
   | `EMAIL_CODE_SECRET` | secret, optional | a random 32+ character string for the code / address hashes (falls back to `RESET_TOKEN_SECRET`, which must stay set) |

   Turn `EMAIL_CODE_SIGNIN_ENABLED=true` on only after the domain is verified and the key is set. **Until then,
   candidates without a Google account cannot sign in or sign up at all** (there are no passwords any more); they can
   still apply as guests.
5. **Check:** on the site, "התחברות" → "קבלת קוד למייל" with your own address; the code arrives within a minute
   (check spam the first time). In Resend → *Emails* you see it as delivered. In the server log you see
   `[email] sent id=… kind=sign_in_code` — ids only, never the address.

## Templates and the other emails
The text of the code email (and of every other email the site sends) is edited on the mail screen
(`/mail-management`, content managers and admins): `docs/mail.md`. The code email cannot be turned off while sign-in by code
is on, must keep `{{code}}`, and falls back to the default text if its template cannot be rendered. An address that
bounced or complained is not sent to (the log says `auth.email_code_send_failed` with `error: suppressed`).

## Errors in the server log
`[email] not sent (em2)` key or `EMAIL_FROM` missing while `SEND_EMAIL_ENABLED=true` · `(em3)` timeout (10 s) or network
· `(em4): HTTP <status>` Resend refused (401/403: wrong key or permission; 422: `EMAIL_FROM` not on a verified domain;
429: Resend's rate limit). A failed sign-in code is also in the activity log as `auth.email_code_send_failed`.

## Local development
No email is sent (`SEND_EMAIL_ENABLED` is not true): the server prints only the kind of each email (never its text or
subject: they can hold a code, a name or an address — not even in development). Codes are
read from `GET|POST /api/dev/email-code` (`test/helpers/candidate.mjs`), which exists only with `DEV_MODE=true`
and never with `NODE_ENV=production`.
