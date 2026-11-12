# SKEELZ Jobs (xhostd) — rules for changes

One Node process: Express API (`server/`) + built React client (`client/dist`). Postgres on xhostd. See README.md,
`docs/security.md` (how candidates' data is protected).

## Security rules (keep these; tests enforce most of them)
- **Every route has a gate.** Import `contentManagerOnly` / `adminOnly` / `signedIn` from
  `server/src/middleware/jwtAuthMiddleware.ts`, or use `tryExtractTokenPayloadMiddleware`. A route without one must be
  added to the public list in `server/test/gates.test.mjs` with a reason, or the test fails.
- **Separation of duties.** Jobs management and anything that shows candidates (lists, applications, CVs) →
  `contentManagerOnly`. Security, the activity log and staff users (`/admin/security|audit|staff`) → `adminOnly`.
  Admins never see candidates. Add new routes to the lists in `gates.test.mjs`.
- **Roles come from the DB, never from the token.** Read `req.authUser.role` / `req.authJwtPayload.userRole` (both are
  set from the DB by the middleware). Don't decode JWTs yourself.
- **Anything that returns candidates goes through `peopleHandover`; any way to open a CV goes through `cvHandover`**
  (`server/src/security/handover.ts`): daily limit, strict log entry with the ids shown before the data leaves, alerts.
- **Admin actions are logged** with `writeAudit(actorOf(req), '<area>.<verb>', target, details)`. Add new action names
  to the table in `docs/security.md` and to `ACTION_LABELS` in `client/src/components/security/SecurityManagement.tsx`.
  Never put passwords, tokens or field values of a candidate in `details` (field names only).
- **The activity log is append-only** (DB trigger) and kept 24 months. Don't add code that updates or deletes it;
  `purgeAudit` is the only delete.
- **No personal data in console output.** `security/redact.ts` masks it, but log ids and codes, not emails, names,
  phone numbers or third-party response bodies.
- **The privacy texts must stay true.** Changing `LIMITS`, `AUDIT_RETENTION_MONTHS` or `REVIEW`
  (`server/src/security/pure.ts`), what is logged, or who receives data → update `client/src/components/privacy/PrivacyPage.tsx`
  (`PRIVACY_NUMBERS`, `PRIVACY_UPDATED`) and `docs/privacy/*.md` in the same change. `npm test` checks the numbers.
- Salesforce, SMOOV and analytics stay off unless the owner turns them on (`ENABLE_*`, `SEND_EMAIL_ENABLED`, `GTM_ID`).
- Public pages: the job board, a job page, password reset, `/privacy`, `/developers` (API + MCP docs; numbers checked by `test/public.test.mjs`). `/jobs-management` is content-manager-only,
  `/security-management` admin-only, `/users-management` shows candidates to content managers and staff users to
  admins (client guard + server gates).

## Tests
- `cd server && npx tsc && npm test` — unit tests (limits arithmetic, dates, reviews, redaction, privacy numbers) and
  the gate coverage test.
- `BASE=http://localhost:3100 node test/e2e.mjs` — end-to-end checks (local server only; needs the dev admin and
  content manager from `server/.env.example`).
- `BASE=http://localhost:3100 node test/e2e-submissions.mjs` — employer job form: submit → private → approve/reject
  (14 checks; restart the server before re-running — it spends the per-IP submission limit).
- `BASE=http://localhost:3100 node test/e2e-jobs-admin.mjs` — jobs-management screen: pin order on every public listing,
  private / scheduled / archived hidden from the public API and MCP, soft delete + restore, integrations can't overwrite
  the board, admin refused (10 checks). Rules: `docs/jobs-management.md`.
- `BASE=… DATABASE_URL=… node test/live-security.mjs` — limit race, strict hand-over, append-only trigger, role from
  DB, revoked tokens, cross-site. Needs a **fresh** local database.
- No email provider: `emailService.sendEmail` only logs. Adding one needs the owner's OK
  and a privacy-text update (who receives data).
