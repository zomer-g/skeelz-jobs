import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg from 'pg';
import appConfig from './appConfig.js';

const { Pool } = pg;

// One small pool: the app is a single process on a shared, memory-tight account.
export const pool = new Pool({
  connectionString: appConfig.dbURL,
  max: Number(process.env.DB_POOL_MAX) || 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export const query = async <T = any>(text: string, params: any[] = []): Promise<T[]> => {
  const res = await pool.query(text, params);
  return res.rows as T[];
};

export const queryOne = async <T = any>(text: string, params: any[] = []): Promise<T | null> => {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
};

/** Escapes a value for use inside a LIKE/ILIKE pattern (we use '\' as the escape char). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Escapes a string so it matches literally inside a POSIX regex (~*). */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Idempotent schema. Runs at boot (launch.sh), never at build time.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS locations (
  city_symbol  integer PRIMARY KEY,
  city         text NOT NULL,
  district     text NOT NULL DEFAULT '',
  identifier   integer NOT NULL
);
-- WGS84 point of the settlement (map search). Filled from seed/settlement-coords.json.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lng double precision;

CREATE TABLE IF NOT EXISTS skills (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS jobs_job_id_seq;

CREATE TABLE IF NOT EXISTS jobs (
  id                    text PRIMARY KEY,
  job_id                integer NOT NULL UNIQUE DEFAULT nextval('jobs_job_id_seq'),
  title                 text NOT NULL,
  job_scope             text[] NOT NULL DEFAULT '{}',
  company_name          text NOT NULL,
  publish_date          timestamptz NOT NULL,
  city_symbol           integer NOT NULL,
  description           text NOT NULL,
  contact_person_name   text,
  contact_person_phone  text,
  contact_person_email  text,
  external_link         text,
  upload_by             text,
  status                text NOT NULL CHECK (status IN ('Active','Suspended','Closed')),
  comments              text,
  required_skills       text[] NOT NULL DEFAULT '{}',
  is_sponsored          boolean NOT NULL DEFAULT false,
  is_marked             boolean NOT NULL DEFAULT false,
  is_self_apply         boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_publish_idx ON jobs (status, publish_date DESC);

CREATE TABLE IF NOT EXISTS users (
  id                  text PRIMARY KEY,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  email               text NOT NULL,
  phone_number        text NOT NULL UNIQUE,
  date_of_birth       timestamptz,
  gender              text NOT NULL DEFAULT '',
  city_symbol         integer NOT NULL,
  password            text NOT NULL DEFAULT '',
  skills              text[] NOT NULL DEFAULT '{}',
  cv_file_url         text NOT NULL DEFAULT '',
  has_applied_to_job  boolean NOT NULL DEFAULT false,
  role                text NOT NULL DEFAULT 'user' CHECK (role IN ('admin','content_manager','user')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Separation of duties (2026-11): content managers see jobs and candidates; admins see security only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at      timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%content_manager%') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','content_manager','user','employer'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_staff_idx ON users (role) WHERE role <> 'user';

-- One-time data migrations that must not repeat (see migrate()).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name     text PRIMARY KEY,
  applied  timestamptz NOT NULL DEFAULT now(),
  details  jsonb
);

-- Sign-in codes sent by email (candidates; security/emailCode.ts). No address and no code in clear: keyed hashes
-- only. Rows hold no candidate data and are deleted a day after they were made (emailSigninController).
CREATE TABLE IF NOT EXISTS email_codes (
  id          bigserial PRIMARY KEY,
  email_key   text NOT NULL,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  sent        boolean NOT NULL DEFAULT true,
  dev         boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS email_codes_key_idx ON email_codes (email_key, created_at DESC);

CREATE TABLE IF NOT EXISTS job_applications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);
-- The CV used for this application (a cv_uploads key; '' or NULL = none) and
-- whether it was the profile CV or one uploaded for this job only. It stays
-- with the application even if the profile CV changes later. Nullable so a
-- sandbox copy from an older export (no such keys) still loads.
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cv_file_url text DEFAULT '';
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cv_scope text DEFAULT '';

CREATE TABLE IF NOT EXISTS tokens (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  token       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  type        text NOT NULL,
  used        boolean NOT NULL DEFAULT false,
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tokens_user_type_idx ON tokens (user_id, type) WHERE disabled = false;

-- CV uploads that are not yet attached to a user/application. An anonymous
-- visitor may only delete an upload that is still pending, and a key can be
-- claimed once, so nobody can delete or adopt someone else's CV.
CREATE TABLE IF NOT EXISTS cv_uploads (
  key         text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by  text
);

-- Jobs sent by employers through the public form (/post-job). Kept apart from
-- "jobs" on purpose: nothing here is public until staff approve it, and approval
-- creates the job (job_id). Contact details are personal data, staff-only; rows
-- are deleted SUBMISSION_RETENTION_MONTHS (12) after review (or after sending if
-- never reviewed) — purgeSubmissions, index.ts.
CREATE TABLE IF NOT EXISTS job_submissions (
  id               text PRIMARY KEY,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  title            text NOT NULL,
  company_name     text NOT NULL,
  city_symbol      integer NOT NULL,
  job_scope        text[] NOT NULL DEFAULT '{}',
  required_skills  text[] NOT NULL DEFAULT '{}',
  description      text NOT NULL,
  external_link    text,
  public_email     text,
  contact_name     text NOT NULL,
  contact_email    text NOT NULL,
  contact_phone    text NOT NULL,
  consent_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  reviewed_by      text,
  reject_reason    text,
  job_id           text REFERENCES jobs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS job_submissions_status_idx ON job_submissions (status, created_at DESC);

-- ---- security: activity log (append-only), alerts, grants, admin reviews ----
-- See server/src/security and docs/security.md. Retention: AUDIT_RETENTION_MONTHS (24).
CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text NOT NULL,
  action   text NOT NULL,
  target   text,
  details  jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx       ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_actor_at_idx ON audit_log (actor, at);
CREATE INDEX IF NOT EXISTS audit_log_details_idx  ON audit_log USING gin (details jsonb_path_ops);
CREATE INDEX IF NOT EXISTS audit_log_target_idx   ON audit_log (left(target, 1000) text_pattern_ops);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log entries cannot be changed' USING ERRCODE = 'insufficient_privilege';
  ELSIF TG_OP = 'DELETE' AND OLD.at >= now() - make_interval(months => 24) THEN
    RAISE EXCEPTION 'audit_log entries are kept for 24 months' USING ERRCODE = 'insufficient_privilege';
  ELSIF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'audit_log cannot be truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only_rows') THEN
    CREATE TRIGGER audit_log_append_only_rows BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_truncate') THEN
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS security_alerts (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  user_email  text NOT NULL,
  day         date NOT NULL,
  threshold   integer NOT NULL DEFAULT 0,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz,
  handled_by  text,
  UNIQUE (kind, user_email, day, threshold)
);

CREATE TABLE IF NOT EXISTS quota_grants (
  id          bigserial PRIMARY KEY,
  budget      text NOT NULL CHECK (budget IN ('cvs','people')),
  user_email  text NOT NULL,
  day         date NOT NULL,
  extra       integer NOT NULL CHECK (extra > 0),
  granted_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quota_grants_user_day_idx ON quota_grants (user_email, day);

CREATE TABLE IF NOT EXISTS access_reviews (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL,
  reviewed_by     text NOT NULL,
  role_at_review  text NOT NULL,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS access_reviews_user_idx ON access_reviews (user_id, reviewed_at DESC);
-- Per-job apply policy overrides; NULL = inherit the site-wide default (app_settings).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quick_apply_override boolean;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quick_apply_without_cv_override boolean;

-- Jobs management (models/schemas/jobBoard.ts, docs/jobs-management.md):
-- pinned_at  = "bumped to the top" (הקפצה); NULL = not pinned. Public order: pinned_at DESC NULLS LAST, publish_date DESC.
-- is_public  = retired (no private jobs; the status alone decides what the public sees). Kept for a rollback.
-- deleted_at = soft delete (archive); restore clears it. Applications are never deleted with a job.
-- managed_fields = board fields set on the management screen; integrations (internal API, Salesforce) don't overwrite them.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS managed_fields text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS jobs_pinned_idx ON jobs (pinned_at DESC) WHERE pinned_at IS NOT NULL;
-- bumped_at = last "bump" (הקפצה): listed as if published then; pinned_at = pinned (נעוצה) until unpinned.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bumped_at timestamptz;
-- A job with applications is never hard-deleted (job_applications.job_id cascades): archive it instead.
CREATE OR REPLACE FUNCTION jobs_keep_applications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_applications WHERE job_id = OLD.id) THEN
    RAISE EXCEPTION 'job % has applications: archive it (deleted_at) instead of deleting', OLD.id;
  END IF;
  RETURN OLD;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_keep_applications') THEN
    CREATE TRIGGER jobs_keep_applications BEFORE DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_keep_applications();
  END IF;
END $$;

-- Site-wide settings edited by admins, one JSON value per key (e.g. 'applyPolicy').
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Ways to apply (models/schemas/applyPolicy.ts, docs/jobs-management.md "Ways to apply").
-- Per-job overrides, NULL = inherit the site-wide default (app_settings 'applyPolicy'):
--   guest_mode_override  what a visitor who is not signed in can do: self (הגשה עצמאית) / quick (הגשה מהירה) / none
--   quick_cv_override / regular_cv_override  CV required or optional on a quick / regular application
-- is_self_apply stays = (effective guest mode = 'self'); Salesforce reads it as isSelfApply_cambium__c.
-- The old quick_apply_override / quick_apply_without_cv_override columns are no longer read (kept for a rollback).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS guest_mode_override text CHECK (guest_mode_override IN ('self', 'quick', 'none'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quick_cv_override text CHECK (quick_cv_override IN ('required', 'optional'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS regular_cv_override text CHECK (regular_cv_override IN ('required', 'optional'));
-- One-time move of the old settings (runs once; the marker row makes it idempotent).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'migration.apply_modes_v1') THEN
    UPDATE jobs SET
      guest_mode_override = CASE WHEN is_self_apply THEN 'self'
                                 WHEN quick_apply_override IS TRUE THEN 'quick'
                                 WHEN quick_apply_override IS FALSE THEN 'none' END,
      quick_cv_override = CASE WHEN quick_apply_without_cv_override IS TRUE THEN 'optional'
                               WHEN quick_apply_without_cv_override IS FALSE THEN 'required' END
    WHERE guest_mode_override IS NULL AND quick_cv_override IS NULL AND regular_cv_override IS NULL;
    UPDATE app_settings SET value = jsonb_build_object(
        'guestMode', CASE WHEN value->>'quickApply' = 'false' THEN 'none' ELSE 'quick' END,
        'quickCv', CASE WHEN value->>'quickApplyWithoutCv' = 'false' THEN 'required' ELSE 'optional' END,
        'regularCv', 'optional'), updated_at = now()
      WHERE key = 'applyPolicy' AND NOT (value ? 'guestMode');
    INSERT INTO app_settings (key, value, updated_by) VALUES ('migration.apply_modes_v1', '{"done": true}', 'migration');
  END IF;
END $$;

-- No private jobs any more: only the status decides. An Active job that was private becomes Suspended
-- (still hidden), so retiring the flag never publishes anything. Runs once (marker row).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'migration.no_private_v1') THEN
    UPDATE jobs SET status = 'Suspended', updated_at = now() WHERE is_public = false AND status = 'Active';
    UPDATE jobs SET is_public = true WHERE is_public = false;
    INSERT INTO app_settings (key, value, updated_by) VALUES ('migration.no_private_v1', '{"done": true}', 'migration');
  END IF;
END $$;

-- "Continue with Google" = xhostd SSO (config/ssoConfig.ts). xhostd_sub: the stable Google id xhostd signs,
-- linked to a candidate or a staff account. It never grants a role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS xhostd_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_xhostd_sub_idx ON users (xhostd_sub) WHERE xhostd_sub IS NOT NULL;
-- "Continue with Microsoft" (candidates only; security/microsoft.ts). ms_sub = '<tenant id>:<sub>' of the Microsoft
-- identity, linked to a candidate by verified email. It never grants a role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_ms_sub_idx ON users (ms_sub) WHERE ms_sub IS NOT NULL;
-- A candidate created by SSO sign-in has no phone number yet (NULLs don't collide in the UNIQUE index).
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;

-- ---- internal API (server/src/internalApi, docs/security.md "Internal API") ----
-- Tokens issued by an admin. Only the SHA-256 of the token is stored; prefix is
-- the short visible part (also the actor in the activity log: token:<prefix>).
CREATE TABLE IF NOT EXISTS api_tokens (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,
  token_hash    text NOT NULL UNIQUE,
  scopes        text[] NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  revoked_by    text,
  last_used_at  timestamptz
);
-- created_by is the actor string written in the log (a staff email); created_by_user_id is the issuer's
-- account, checked on every use (deactivated, or a role that no longer allows the scopes → refused) and the
-- daily limits are counted on that person. Backfilled from created_by where it names an account.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS created_by_user_id text;
UPDATE api_tokens t SET created_by_user_id = u.id FROM users u
 WHERE t.created_by_user_id IS NULL
   AND (lower(u.email) = lower(t.created_by) OR t.created_by = 'user:' || u.id);
CREATE INDEX IF NOT EXISTS api_tokens_issuer_idx ON api_tokens (created_by_user_id) WHERE revoked_at IS NULL;

-- What was pushed to Salesforce through the internal API: one row per record.
-- Error codes only (http_<status>, auth, not_found…), never third-party bodies.
CREATE TABLE IF NOT EXISTS salesforce_sync (
  kind             text NOT NULL CHECK (kind IN ('job','application','candidate')),
  record_id        text NOT NULL,
  sf_id            text,
  last_pushed_at   timestamptz,
  last_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error_code  text,
  attempts         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, record_id)
);

-- ---- consent (security/consent.ts, /privacy) ----
-- Required box: terms of use + privacy policy, by version and time. Optional box: marketing mail and updates
-- about cooperations (NULL = never asked). Only marketing_consent = true may reach the mailing list.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version        text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at    timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent    boolean;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz;
-- Israeli ID number (תעודת זהות), 9 digits with a valid check digit (security/pure.ts normalizeIsraeliId); optional
-- unless the sign-up fields setting requires it. Sensitive: never loaded by rowToUser (only the candidate's own view,
-- the staff candidates list through peopleHandover, and Salesforce when the org has the field).
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number text;
-- Answers to the fields content managers added (models/schemas/customFields.ts, keyed by the field's id). Like the ID
-- number, never loaded by rowToUser: only the candidate's own view and the staff candidates list (peopleHandover).
-- Never sent to Salesforce or to employers.
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE jobs  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS terms_version        text;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS marketing_consent    boolean;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz;
-- A guest application leaves no users / job_applications row, so its consent is kept here (guest_id is the
-- same random id the CV upload and the CRM record carry). The email is kept as proof of who agreed and so a
-- "no more mail" request can be honoured.
CREATE TABLE IF NOT EXISTS guest_consents (
  guest_id             text PRIMARY KEY,
  job_id               text NOT NULL,
  email                text NOT NULL,
  terms_version        text NOT NULL,
  terms_accepted_at    timestamptz NOT NULL,
  marketing_consent    boolean NOT NULL,
  marketing_consent_at timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guest_consents_email_idx ON guest_consents (lower(email));

-- Every version of the privacy policy + terms (security/consent.ts TERMS_VERSION), as published: the page rendered
-- to HTML (server/privacy-versions/<id>.html, added on every migrate, never changed). Versions before 2026-11-19
-- were not kept (owner, 19.11.2026: nobody had really accepted them).
CREATE TABLE IF NOT EXISTS privacy_versions (
  id           text PRIMARY KEY,
  sha256       text NOT NULL,
  content      text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
-- Every acceptance of the terms (and every marketing answer): when, who (an account, a quick application's guest id
-- or an employer job submission) and which version. Append-only, like audit_log: the users / guest_consents /
-- job_submissions columns keep only the latest answer, this keeps each one.
CREATE TABLE IF NOT EXISTS consent_records (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('user', 'guest', 'job_submission')),
  subject_id      text NOT NULL,
  privacy_version text REFERENCES privacy_versions(id),
  marketing       boolean,
  source          text NOT NULL,
  CHECK (privacy_version IS NOT NULL OR marketing IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS consent_records_subject_idx ON consent_records (subject_kind, subject_id, at);
CREATE OR REPLACE FUNCTION consent_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'consent_records_append_only') THEN
    CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION consent_keep();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'consent_records_no_truncate') THEN
    CREATE TRIGGER consent_records_no_truncate BEFORE TRUNCATE ON consent_records FOR EACH STATEMENT EXECUTE FUNCTION consent_keep();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'privacy_versions_keep') THEN
    CREATE TRIGGER privacy_versions_keep BEFORE UPDATE OR DELETE ON privacy_versions FOR EACH ROW EXECUTE FUNCTION consent_keep();
  END IF;
END $$;

-- Guest (quick) applications: every one is kept (owner's rule: nothing a candidate sent is deleted) and goes to
-- Salesforce when it is on. id = the guest id (guest_consents.guest_id, cv_uploads.claimed_by); application_id =
-- the id the Salesforce Case carries. salesforce_sent_at NULL = not in Salesforce yet (pushed later by staff).
CREATE TABLE IF NOT EXISTS guest_applications (
  id                     text PRIMARY KEY,
  application_id         text NOT NULL UNIQUE,
  job_id                 text NOT NULL,
  full_name              text NOT NULL,
  email                  text NOT NULL,
  phone_number           text NOT NULL,
  cv_key                 text NOT NULL DEFAULT '',
  created_at             timestamptz NOT NULL DEFAULT now(),
  salesforce_sent_at     timestamptz,
  salesforce_attempt_at  timestamptz,
  salesforce_error       text
);
CREATE INDEX IF NOT EXISTS guest_applications_created_idx ON guest_applications (created_at DESC);
-- One quick application per address and job (jobApplicationService.guestApplyJob checks it; not UNIQUE: older rows stay).
CREATE INDEX IF NOT EXISTS guest_applications_job_email_idx ON guest_applications (job_id, email);
CREATE INDEX IF NOT EXISTS guest_applications_unsent_idx ON guest_applications (created_at) WHERE salesforce_sent_at IS NULL;
CREATE OR REPLACE FUNCTION guest_applications_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'guest applications are never deleted' USING ERRCODE = 'insufficient_privilege';
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guest_applications_keep_rows') THEN
    CREATE TRIGGER guest_applications_keep_rows BEFORE DELETE ON guest_applications FOR EACH ROW EXECUTE FUNCTION guest_applications_keep();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guest_applications_keep_table') THEN
    CREATE TRIGGER guest_applications_keep_table BEFORE TRUNCATE ON guest_applications FOR EACH STATEMENT EXECUTE FUNCTION guest_applications_keep();
  END IF;
END $$;

-- Jobs imported from the existing site (scripts/importFromLive.ts; marked by markImportedJobs below) are read-only
-- here: the same jobs live in the existing site and in Salesforce, so this platform never changes or removes them.
-- Only jobs created on this platform can be edited, pinned, bumped, archived or deleted. The app refuses first
-- (jobDAL.assertJobEditable, 409 job_read_only); this trigger is the backstop for any other path.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS imported_from_live boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION jobs_imported_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.imported_from_live AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'job % was imported from the existing site and is read-only', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_imported_readonly') THEN
    CREATE TRIGGER jobs_imported_readonly BEFORE UPDATE OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_imported_readonly();
  END IF;
END $$;

-- ---- jobs of the existing site, read from Salesforce (services/legacyJobs.ts; docs/jobs-management.md) ----
-- legacy_state: 'mirror' = the existing site still manages the job; this site keeps a copy read from its Position Case
--   in Salesforce (status and fields), read-only here, never pushed. 'owned' = after the cutover (LEGACY_JOBS_MODE=owned)
--   this site manages it and writes that same Case (legacy_sf_id). Only the mirror changes a 'mirror' row, and only it
--   or the mode switch change the mark: both set skeelz.legacy_writer = 'on' for their transaction. Never deleted.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS legacy_state text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS legacy_sf_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS legacy_synced_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_legacy_state_check') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_legacy_state_check CHECK (legacy_state IN ('mirror','owned'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS jobs_legacy_idx ON jobs (legacy_state) WHERE legacy_state IS NOT NULL;
CREATE OR REPLACE FUNCTION jobs_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE writer boolean := COALESCE(current_setting('skeelz.legacy_writer', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.legacy_state IS NOT NULL THEN
      RAISE EXCEPTION 'job % belongs to the existing site and is never deleted', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT writer AND NEW.legacy_state IS DISTINCT FROM OLD.legacy_state THEN
    RAISE EXCEPTION 'job %: only the existing-site mirror changes legacy_state', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT writer AND OLD.legacy_state = 'mirror' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'job % is managed by the existing site and is read-only here', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_legacy_guard') THEN
    CREATE TRIGGER jobs_legacy_guard BEFORE UPDATE OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_legacy_guard();
  END IF;
END $$;
-- A candidate's Contact found by email (an existing site's Contact, adopted): its ID_cambium__c, which the application
-- Cases carry in A_CID_cambium__c (the new_applied Flow matches on it), and how it was found ('email', 'email_ambiguous').
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS sf_legacy_cid text;
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS sf_match text;

-- ---- candidates of the existing site, read from Salesforce (services/legacyCandidates.ts; docs/salesforce.md 1ב) ----
-- legacy_state: 'mirror' = until the cutover a copy of the Contact, read-only here (the candidate views, never edits or
--   applies); 'owned' = after it an ordinary candidate whose changes go to the SAME Contact (legacy_sf_id), keeping its
--   ID_cambium__c (legacy_cid). legacy_match: 'ambiguous' when several Contacts had this email (the newest is used).
--   legacy_cv: the newest file on the Contact (a pointer, never a copy: cv_file_url = 'sf:<ContentVersion id>', opened
--   from Salesforce only when someone opens it, through the same hand-overs). Only the mirror and the mode switch change
--   a 'mirror' row's data or anyone's mark (SET LOCAL skeelz.legacy_writer = 'on').
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_state text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_sf_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_cid text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_match text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_cv jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_synced_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_legacy_state_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_legacy_state_check CHECK (legacy_state IN ('mirror','owned'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_legacy_idx ON users (legacy_state) WHERE legacy_state IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_sf_id_idx ON users (legacy_sf_id) WHERE legacy_sf_id IS NOT NULL;
-- A mirrored candidate deleted here (a deletion request) is not copied again: its Contact id stays here.
CREATE TABLE IF NOT EXISTS legacy_candidates_removed (
  sf_id      text PRIMARY KEY,
  removed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION users_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE writer boolean := COALESCE(current_setting('skeelz.legacy_writer', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.legacy_sf_id IS NOT NULL THEN
      INSERT INTO legacy_candidates_removed (sf_id) VALUES (OLD.legacy_sf_id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN OLD;
  END IF;
  IF NOT writer AND (NEW.legacy_state IS DISTINCT FROM OLD.legacy_state OR NEW.legacy_sf_id IS DISTINCT FROM OLD.legacy_sf_id
                     OR NEW.legacy_cid IS DISTINCT FROM OLD.legacy_cid) THEN
    RAISE EXCEPTION 'user %: only the existing-site mirror changes the legacy mark', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Sign-in links, consent, sessions and deactivation stay possible; the candidate's details do not.
  IF NOT writer AND OLD.legacy_state = 'mirror' AND (
       NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name
    OR NEW.email IS DISTINCT FROM OLD.email OR NEW.phone_number IS DISTINCT FROM OLD.phone_number
    OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth OR NEW.gender IS DISTINCT FROM OLD.gender
    OR NEW.city_symbol IS DISTINCT FROM OLD.city_symbol OR NEW.skills IS DISTINCT FROM OLD.skills
    OR NEW.cv_file_url IS DISTINCT FROM OLD.cv_file_url OR NEW.id_number IS DISTINCT FROM OLD.id_number
    OR NEW.custom_fields IS DISTINCT FROM OLD.custom_fields
    OR NOT ('user' = ANY(COALESCE(NEW.roles, ARRAY[NEW.role]))) OR NEW.has_applied_to_job IS DISTINCT FROM OLD.has_applied_to_job
    OR NEW.legacy_cv IS DISTINCT FROM OLD.legacy_cv OR NEW.legacy_match IS DISTINCT FROM OLD.legacy_match) THEN
    RAISE EXCEPTION 'user % is a candidate of the existing site and is read-only here until the cutover', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_legacy_guard') THEN
    CREATE TRIGGER users_legacy_guard BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION users_legacy_guard();
  END IF;
END $$;
-- Applications go by the job, not the candidate (owner, 23.11.2026; was: a mirrored candidate never applies): a job of
-- the existing site (imported, or mirrored while that site still manages it) takes no application here; a job made on
-- this site takes them from every candidate, one copied from the existing site included. Backstop of
-- errorMiddleware.assertJobTakesApplications, for quick applications too.
CREATE OR REPLACE FUNCTION job_applications_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM jobs WHERE id = NEW.job_id AND (imported_from_live OR legacy_state = 'mirror')) THEN
    RAISE EXCEPTION 'job % is managed on the existing site: no application here', NEW.job_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'job_applications_legacy_guard') THEN
    CREATE TRIGGER job_applications_legacy_guard BEFORE INSERT ON job_applications FOR EACH ROW EXECUTE FUNCTION job_applications_legacy_guard();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guest_applications_legacy_guard') THEN
    CREATE TRIGGER guest_applications_legacy_guard BEFORE INSERT ON guest_applications FOR EACH ROW EXECUTE FUNCTION job_applications_legacy_guard();
  END IF;
END $$;

-- ---- employer accounts (11.2026; docs/employers.md) ----
-- An employer signs in like a candidate (Google, Microsoft, code by email) and chooses "employer" on the sign-up
-- form. Role 'employer' in users (never staff, never a candidate: phone_number stays NULL, city_symbol 0); the
-- employer's own details are here. Nothing in the candidate views reads this table (they filter role = 'user').
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%employer%') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','content_manager','user','employer'));
  END IF;
END $$;
-- Placement coordinators (רכז השמה, 11.2026; docs/security.md): staff who see candidates (view only) and manage jobs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%placement_coordinator%') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin','content_manager','placement_coordinator','user','employer'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS employer_profiles (
  user_id       text PRIMARY KEY REFERENCES users(id),
  company_name  text NOT NULL,
  phone         text NOT NULL,
  job_title     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- A submission sent while signed in carries the account; earlier anonymous ones can be claimed by the verified
-- account email only (claimed_at set).
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS submitted_by_user_id text;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS job_submissions_owner_idx ON job_submissions (submitted_by_user_id) WHERE submitted_by_user_id IS NOT NULL;
-- Which published jobs are an employer's: set when their submission is approved (or claimed after approval). Kept
-- apart from "jobs" (no new job column can reach a public serializer, and a job imported from the existing site,
-- which is read-only, can still be shown to its employer) and kept when the submission itself is purged.
CREATE TABLE IF NOT EXISTS employer_jobs (
  job_id     text PRIMARY KEY REFERENCES jobs(id),
  user_id    text NOT NULL REFERENCES users(id),
  linked_at  timestamptz NOT NULL DEFAULT now(),
  via        text NOT NULL DEFAULT 'submission'
);
CREATE INDEX IF NOT EXISTS employer_jobs_user_idx ON employer_jobs (user_id);
-- Edit requests: an employer's change to one of THEIR published jobs. The live job is untouched until a content
-- manager approves (applied through jobDAL.updateJobById); a rejection keeps the job as it is. changes = the
-- requested values (plain text), base = the job's values when the request was made (to show what changed since).
CREATE TABLE IF NOT EXISTS job_edit_requests (
  id             text PRIMARY KEY,
  job_id         text NOT NULL REFERENCES jobs(id),
  user_id        text NOT NULL REFERENCES users(id),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  changes        jsonb NOT NULL,
  base           jsonb NOT NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_at    timestamptz,
  reviewed_by    text,
  reject_reason  text
);
CREATE INDEX IF NOT EXISTS job_edit_requests_status_idx ON job_edit_requests (status, created_at);
CREATE INDEX IF NOT EXISTS job_edit_requests_user_idx ON job_edit_requests (user_id, created_at DESC);
-- At most one pending request per job (a second one waits until the first is reviewed or withdrawn).
CREATE UNIQUE INDEX IF NOT EXISTS job_edit_requests_one_pending ON job_edit_requests (job_id) WHERE status = 'pending';
-- The employer's Salesforce Contact (when ENABLE_SALESFORCE is on): its sync state, like the other kinds.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salesforce_sync_kind_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%employer%') THEN
    ALTER TABLE salesforce_sync DROP CONSTRAINT salesforce_sync_kind_check;
    ALTER TABLE salesforce_sync ADD CONSTRAINT salesforce_sync_kind_check CHECK (kind IN ('job','application','candidate','employer'));
  END IF;
END $$;

-- The Account made for an employer's company (11.2026; docs/salesforce.md): kind 'employer' keeps it here.
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS sf_account_id text;

-- ---- employers see the applicants forwarded to them (11.2026; docs/employers.md "Applicants") ----
-- When a job stopped being active (status not Active, or removed from the board: deleted_at). since = NULL while it
-- is active again. Kept by a trigger on jobs (every path that changes status / deleted_at); the employer's access
-- to forwarded applicants ends EMPLOYER_ACCESS_DAYS (90) after since. A separate table, so no new column can reach
-- a job serializer and the read-only trigger on imported jobs is untouched.
CREATE TABLE IF NOT EXISTS job_inactive_since (
  job_id  text PRIMARY KEY,
  since   timestamptz
);
CREATE OR REPLACE FUNCTION jobs_track_inactive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'Active' AND NEW.deleted_at IS NULL THEN
    UPDATE job_inactive_since SET since = NULL WHERE job_id = NEW.id AND since IS NOT NULL;
  ELSE
    INSERT INTO job_inactive_since (job_id, since) VALUES (NEW.id, now())
      ON CONFLICT (job_id) DO UPDATE SET since = now() WHERE job_inactive_since.since IS NULL;
  END IF;
  RETURN NULL;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_track_inactive') THEN
    CREATE TRIGGER jobs_track_inactive AFTER INSERT OR UPDATE OF status, deleted_at ON jobs
      FOR EACH ROW EXECUTE FUNCTION jobs_track_inactive();
  END IF;
END $$;
-- Jobs already not active before the trigger existed: the best known moment (removal time, else the last change).
INSERT INTO job_inactive_since (job_id, since)
  SELECT id, COALESCE(deleted_at, updated_at) FROM jobs WHERE NOT (status = 'Active' AND deleted_at IS NULL)
  ON CONFLICT (job_id) DO NOTHING;

-- A content manager (or admin) forwards ONE application to the employer who owns the job (employer_jobs). Nothing
-- reaches an employer without a row here. kind 'application' = job_applications.id (candidate_id = users.id),
-- 'guest' = guest_applications.id (candidate_id = the same guest id). first_seen_at = the first time the employer
-- was shown it (list or CV); a forward can be cancelled only before that. Rows are never deleted (a cancelled one
-- keeps its history); the trigger enforces it, and the identity columns never change.
CREATE TABLE IF NOT EXISTS employer_forwards (
  id                text PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('application','guest')),
  application_id    text NOT NULL,
  candidate_id      text NOT NULL,
  job_id            text NOT NULL REFERENCES jobs(id),
  employer_user_id  text NOT NULL REFERENCES users(id),
  forwarded_at      timestamptz NOT NULL DEFAULT now(),
  forwarded_by      text NOT NULL,
  first_seen_at     timestamptz,
  cancelled_at      timestamptz,
  cancelled_by      text
);
CREATE UNIQUE INDEX IF NOT EXISTS employer_forwards_one_live ON employer_forwards (kind, application_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS employer_forwards_employer_idx ON employer_forwards (employer_user_id, job_id) WHERE cancelled_at IS NULL;
CREATE OR REPLACE FUNCTION employer_forwards_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'employer forwards are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.kind, NEW.application_id, NEW.candidate_id, NEW.job_id, NEW.employer_user_id, NEW.forwarded_at, NEW.forwarded_by)
     IS DISTINCT FROM (OLD.kind, OLD.application_id, OLD.candidate_id, OLD.job_id, OLD.employer_user_id, OLD.forwarded_at, OLD.forwarded_by) THEN
    RAISE EXCEPTION 'a forward cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
                                       OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at) THEN
    RAISE EXCEPTION 'a cancelled forward is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.first_seen_at IS NOT NULL AND (NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at OR NEW.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the employer already saw this forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employer_forwards_rules_rows') THEN
    CREATE TRIGGER employer_forwards_rules_rows BEFORE UPDATE OR DELETE ON employer_forwards FOR EACH ROW EXECUTE FUNCTION employer_forwards_rules();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employer_forwards_rules_table') THEN
    CREATE TRIGGER employer_forwards_rules_table BEFORE TRUNCATE ON employer_forwards FOR EACH STATEMENT EXECUTE FUNCTION employer_forwards_rules();
  END IF;
END $$;

-- ---- Salesforce sync queue (11.2026; services/salesforceSync.ts, docs/salesforce.md) ----
-- salesforce_sync is also the queue: queued_at = waiting to be (re)sent; next_attempt_at = when (backoff after a
-- failure); fail_streak = failures in a row (reset on success). sf_contact_id = the Contact an application Case points
-- at; synced_cv_key = the CV file already sent for this record (never sent twice). Codes only, never bodies.
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS queued_at       timestamptz;
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS fail_streak     integer NOT NULL DEFAULT 0;
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS sf_contact_id   text;
ALTER TABLE salesforce_sync ADD COLUMN IF NOT EXISTS synced_cv_key   text;
CREATE INDEX IF NOT EXISTS salesforce_sync_due_idx ON salesforce_sync (next_attempt_at) WHERE queued_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS salesforce_sync_errors_idx ON salesforce_sync (last_attempt_at DESC) WHERE last_error_code IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salesforce_sync_kind_check'
              AND pg_get_constraintdef(oid) NOT LIKE '%guest_application%') THEN
    ALTER TABLE salesforce_sync DROP CONSTRAINT salesforce_sync_kind_check;
    ALTER TABLE salesforce_sync ADD CONSTRAINT salesforce_sync_kind_check
      CHECK (kind IN ('job','application','candidate','employer','guest_application'));
  END IF;
END $$;

-- ---- threshold condition (תנאי סף, 11.2026; models/schemas/thresholdCondition.ts, docs/jobs-management.md) ----
-- One short plain-text condition per job; NULL = none. An application to a job with one is accepted only when the
-- candidate confirmed it (server-side); the application keeps only that they confirmed and when. Employers send it
-- in the job form (job_submissions) and in edit requests (approved by a content manager). Adding the columns does
-- not touch existing rows, so jobs imported from the existing site (read-only trigger) simply have none.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS threshold_condition text;
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS threshold_condition text;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS threshold_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS threshold_confirmed_at timestamptz;
ALTER TABLE guest_applications ADD COLUMN IF NOT EXISTS threshold_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE guest_applications ADD COLUMN IF NOT EXISTS threshold_confirmed_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_threshold_condition_len') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_threshold_condition_len CHECK (threshold_condition IS NULL OR char_length(threshold_condition) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_submissions_threshold_condition_len') THEN
    ALTER TABLE job_submissions ADD CONSTRAINT job_submissions_threshold_condition_len CHECK (threshold_condition IS NULL OR char_length(threshold_condition) <= 500);
  END IF;
END $$;

-- ---- several roles per account (owner, 23.11.2026: "a user can be a candidate, an employer and a content manager /
-- admin at once"). users.roles is the set and the source of truth; users.role is DERIVED here (the primary role:
-- admin > content_manager > placement_coordinator > employer > user), so code that names a person by their highest
-- role keeps working. At most one staff role per account. A write of users.role alone (one-time migrations, old
-- scripts) keeps its old meaning: that is the account's only role. Each role keeps its own gate, hand-overs and
-- limits; staff roles count only on a Google (xhostd SSO) session (security/pure.ts effectiveRoles).
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles text[];
UPDATE users SET roles = ARRAY[role] WHERE roles IS NULL;
ALTER TABLE users ALTER COLUMN roles SET NOT NULL;
CREATE OR REPLACE FUNCTION users_primary_role(r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN 'admin' = ANY(r) THEN 'admin' WHEN 'content_manager' = ANY(r) THEN 'content_manager'
              WHEN 'placement_coordinator' = ANY(r) THEN 'placement_coordinator' WHEN 'employer' = ANY(r) THEN 'employer'
              WHEN 'user' = ANY(r) THEN 'user' END $$;
CREATE OR REPLACE FUNCTION users_roles_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.roles IS NULL THEN
    NEW.roles := ARRAY[NEW.role];
  ELSIF TG_OP = 'UPDATE' AND NEW.roles IS NOT DISTINCT FROM OLD.roles AND NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.roles := ARRAY[NEW.role];
  END IF;
  NEW.roles := ARRAY(SELECT DISTINCT x FROM unnest(NEW.roles) AS x ORDER BY x);
  NEW.role := COALESCE(users_primary_role(NEW.roles), NEW.role);
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_roles_sync') THEN
    CREATE TRIGGER users_roles_sync BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_roles_sync();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_roles_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_roles_check CHECK (
      cardinality(roles) >= 1
      AND roles <@ ARRAY['admin','content_manager','placement_coordinator','user','employer']::text[]
      AND (('admin' = ANY(roles))::int + ('content_manager' = ANY(roles))::int + ('placement_coordinator' = ANY(roles))::int) <= 1);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_roles_idx ON users USING gin (roles);
-- Per-role blocks (owner, 24.11.2026): an admin blocks one of the three kinds of role of an account — 'user'
-- (candidate), 'employer', 'staff' (the account's staff role, whichever) — one by one; the other roles keep working.
-- A blocked role stays in users.roles (the data stays) but counts for nothing: no gate opens on it and no sign-in
-- carries it (models/enums.ts usableRolesOf). Blocking closes every session of the account at once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_roles text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_blocked_roles_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_blocked_roles_check CHECK (blocked_roles <@ ARRAY['user','employer','staff']::text[]);
  END IF;
END $$;
-- Fields content managers add to the candidate sign-up form ('signup') and the staff job form ('job') — the settings
-- screen (/settings, docs/settings.md). Never deleted: turned off (active = false) keeps the answers readable.
CREATE TABLE IF NOT EXISTS custom_fields (
  id               text PRIMARY KEY,
  form             text NOT NULL CHECK (form IN ('signup','job')),
  label            text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  type             text NOT NULL CHECK (type IN ('text','select','checkbox')),
  options          jsonb NOT NULL DEFAULT '[]'::jsonb,
  required         boolean NOT NULL DEFAULT false,
  sort_order       integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  show_on_job_page boolean NOT NULL DEFAULT false,
  help             text NOT NULL DEFAULT '',
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION custom_fields_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'added fields are never deleted (turn them off)' USING ERRCODE = 'insufficient_privilege';
END $$;
-- The Salesforce field an added field goes to (Contact for 'signup', the Position Case for 'job'), linked by an admin;
-- NULL = not sent. Sent only when the org has it (salesforceUtils.customFieldsForSalesforce). docs/settings.md.
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS sf_field text;
-- A sign-up question is asked only after an ADMIN turned it on (owner, 24.11.2026; security review M6: a question may
-- touch sensitive information — health, religion, a criminal record…). approved_* = who / when; cleared when a content
-- manager rewords it (it is off again until an admin approves). Questions already on before this rule count as approved.
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS approved_at timestamptz;
UPDATE custom_fields SET approved_by = 'system:existing', approved_at = now()
 WHERE form = 'signup' AND active AND approved_at IS NULL;
-- The employer form's answers to the added job fields, until the submission is approved (then on the job).
ALTER TABLE job_submissions ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'custom_fields_no_delete') THEN
    CREATE TRIGGER custom_fields_no_delete BEFORE DELETE ON custom_fields FOR EACH ROW EXECUTE FUNCTION custom_fields_no_delete();
  END IF;
END $$;
-- Service emails edited on the site (src/mail, docs/mail.md). One row per kind once someone changed it (no row =
-- the catalog's default: on/off and the default text). enabled_at = when it was last turned on (the job-closed
-- event never reaches back before it).
CREATE TABLE IF NOT EXISTS mail_events (
  kind               text PRIMARY KEY,
  enabled            boolean NOT NULL,
  published_version  bigint,
  enabled_at         timestamptz,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Every saved version of a template is kept (history; a version is never edited, only a new one saved).
CREATE TABLE IF NOT EXISTS mail_template_versions (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS mail_template_versions_kind_idx ON mail_template_versions (kind, id DESC);
-- Addresses we stop sending to (a permanent bounce, a spam complaint, Resend's own suppression): a keyed hash of the
-- address only (emailCode.emailKey), never the address.
CREATE TABLE IF NOT EXISTS mail_suppressions (
  email_key   text PRIMARY KEY,
  reason      text NOT NULL,
  events      int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- One row per email the site tried to send: kind, outcome and Resend's message id. No address, no text.
CREATE TABLE IF NOT EXISTS mail_sends (
  id                bigserial PRIMARY KEY,
  kind              text NOT NULL,
  status            text NOT NULL,
  resend_id         text,
  error             text,
  template_version  bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_sends_resend_idx ON mail_sends (resend_id) WHERE resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_sends_created_idx ON mail_sends (created_at);
-- Webhook message ids already handled (Resend retries; a replay changes nothing twice). Kept two weeks.
CREATE TABLE IF NOT EXISTS mail_webhook_events (
  svix_id      text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now()
);
-- Jobs whose applicants were told the job closed (once per job, ever).
CREATE TABLE IF NOT EXISTS mail_job_closed (
  job_id     text PRIMARY KEY,
  notified   int NOT NULL DEFAULT 0,
  done_at    timestamptz NOT NULL DEFAULT now()
);

-- Marketing mail consent per candidate (security/marketing.ts, docs/marketing-consent.md). users.marketing_consent
-- keeps the latest answer (NULL = never asked); _source where it came from (the same value as the consent_records row
-- written in the same statement); marketing_optout_at = the person asked to be removed (wins over any earlier "yes";
-- cleared only by their own new "yes").
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_source text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_optout_at      timestamptz;
UPDATE users u SET marketing_consent_source = (
    SELECT c.source FROM consent_records c WHERE c.subject_kind = 'user' AND c.subject_id = u.id AND c.marketing IS NOT NULL
     ORDER BY c.at DESC, c.id DESC LIMIT 1)
  WHERE u.marketing_consent IS NOT NULL AND u.marketing_consent_source IS NULL;
-- The removal list: everyone who asked to stop marketing mail, with or without an account. A keyed hash of the
-- address only (emailCode.emailKey), never the address; user_id when an account had it; actor = ids only.
CREATE TABLE IF NOT EXISTS marketing_optouts (
  email_key   text PRIMARY KEY,
  user_id     text,
  via         text NOT NULL CHECK (via IN ('link', 'personal_area', 'staff', 'complaint')),
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_optouts_user_idx ON marketing_optouts (user_id) WHERE user_id IS NOT NULL;
`;

/**
 * One-time role split (separation of duties). Before it, 'admin' did everything. After it:
 *   - the account named by INITIAL_ADMIN_EMAIL (else ADMIN_EMAIL) is the admin (security, staff users);
 *   - every other former admin becomes a content manager (jobs and candidates, as before).
 * Safe by default: when there are former admins but the admin email is unset or has no account, nothing
 * changes and it retries at the next boot (the former admins keep the security screen and see no candidates
 * until then). Recorded in schema_migrations and in the activity log; never runs twice.
 */
export const ROLES_SPLIT_MIGRATION = '2026-11-roles-split';
export const migrateRolesSplit = async (): Promise<string> => {
  const done = await queryOne(`SELECT 1 FROM schema_migrations WHERE name = $1`, [ROLES_SPLIT_MIGRATION]);
  if (done) return 'already applied';
  const admins = await query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE role = 'admin'`);
  const adminEmail = (process.env.INITIAL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (admins.length === 0) {
      await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [ROLES_SPLIT_MIGRATION, JSON.stringify({ former_admins: 0 })]);
      await client.query('COMMIT');
      return 'nothing to split';
    }
    const target = adminEmail
      ? (await client.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [adminEmail])).rows[0]
      : undefined;
    if (!target) {
      await client.query('ROLLBACK');
      console.warn('[migrate] roles split postponed: set INITIAL_ADMIN_EMAIL to the account that will be the admin');
      return 'postponed';
    }
    const moved = await client.query(
      `UPDATE users SET role = 'content_manager', updated_at = now() WHERE role = 'admin' AND id <> $1 RETURNING id`, [target.id]);
    await client.query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [target.id]);
    // Close the moved accounts' sessions; their role is read from the DB anyway.
    await client.query(`UPDATE users SET sessions_revoked_at = now() WHERE id = ANY($1)`, [moved.rows.map((r) => r.id)]);
    await client.query(`UPDATE tokens SET disabled = true WHERE user_id = ANY($1) AND type = 'refreshToken'`, [moved.rows.map((r) => r.id)]);
    const details = { admin: adminEmail, to_content_manager: moved.rowCount ?? 0 };
    await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2)`, [ROLES_SPLIT_MIGRATION, JSON.stringify(details)]);
    await client.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ('system:migration', 'staff.roles_split', $1, $2)`,
      [adminEmail, JSON.stringify(details)]);
    await client.query('COMMIT');
    console.log(`[migrate] roles split: 1 admin, ${details.to_content_manager} content manager(s)`);
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * One-time: candidates sign in by a code sent by email (or with Google) since 11.2026, so their stored password
 * hashes are cleared. Only the password column of role 'user' rows changes: no account, application or CV is touched.
 * Staff never had password sign-in (their column is left as it is; nothing reads it). Recorded in schema_migrations
 * and the activity log (the count only); never runs twice.
 */
export const CLEAR_CANDIDATE_PASSWORDS_MIGRATION = '2026-11-clear-candidate-passwords';
export const migrateClearCandidatePasswords = async (): Promise<string> => {
  const done = await queryOne(`SELECT 1 FROM schema_migrations WHERE name = $1`, [CLEAR_CANDIDATE_PASSWORDS_MIGRATION]);
  if (done) return 'already applied';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE users SET password = '' WHERE role = 'user' AND password IS NOT NULL AND password <> '' RETURNING id`);
    const details = { cleared: r.rowCount ?? 0 };
    await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [CLEAR_CANDIDATE_PASSWORDS_MIGRATION, JSON.stringify(details)]);
    await client.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ('system:migration', 'auth.candidate_passwords_cleared', NULL, $1)`,
      [JSON.stringify(details)]);
    await client.query('COMMIT');
    console.log(`[migrate] candidate password hashes cleared: ${details.cleared}`);
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * One-time (owner's decision, 17.11.2026): the jobs copied from the existing site (imported_from_live) are removed,
 * together with the applications and quick applications sent to them, so Salesforce is connected with only jobs
 * created on this platform. Nothing is deleted in Salesforce (imported jobs were never pushed). The read-only and
 * keep-applications triggers are switched off inside this transaction only and back on before COMMIT. If an
 * employer link, edit request or forward points at such a job (none should), it is postponed and nothing changes.
 * Recorded in schema_migrations and the activity log (counts only); never runs twice. Candidate accounts, their
 * profile CVs and consent records stay.
 */
export const PURGE_IMPORTED_JOBS_MIGRATION = '2026-11-purge-imported-jobs';
export const migratePurgeImportedJobs = async (): Promise<string> => {
  const done = await queryOne(`SELECT 1 FROM schema_migrations WHERE name = $1`, [PURGE_IMPORTED_JOBS_MIGRATION]);
  if (done) return 'already applied';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobIds: string[] = (await client.query(`SELECT id FROM jobs WHERE imported_from_live`)).rows.map((r) => r.id);
    if (jobIds.length) {
      const linked = (await client.query(
        `SELECT (SELECT COUNT(*) FROM employer_jobs WHERE job_id = ANY($1))::int
              + (SELECT COUNT(*) FROM job_edit_requests WHERE job_id = ANY($1))::int
              + (SELECT COUNT(*) FROM employer_forwards WHERE job_id = ANY($1))::int AS n`, [jobIds])).rows[0].n;
      if (linked > 0) {
        await client.query('ROLLBACK');
        console.warn(`[migrate] imported jobs purge postponed: ${linked} employer link(s) point at them`);
        return 'postponed';
      }
    }
    const appIds: string[] = jobIds.length
      ? (await client.query(`SELECT id FROM job_applications WHERE job_id = ANY($1)`, [jobIds])).rows.map((r) => r.id) : [];
    const guestIds: string[] = jobIds.length
      ? (await client.query(`SELECT id FROM guest_applications WHERE job_id = ANY($1)`, [jobIds])).rows.map((r) => r.id) : [];
    let jobsDeleted = 0;
    if (jobIds.length) {
      await client.query(`ALTER TABLE jobs DISABLE TRIGGER jobs_imported_readonly`);
      await client.query(`ALTER TABLE jobs DISABLE TRIGGER jobs_keep_applications`);
      await client.query(`ALTER TABLE guest_applications DISABLE TRIGGER guest_applications_keep_rows`);
      await client.query(
        `DELETE FROM salesforce_sync WHERE (kind = 'job' AND record_id = ANY($1)) OR (kind = 'application' AND record_id = ANY($2))
            OR (kind = 'guest_application' AND record_id = ANY($3))`, [jobIds, appIds, guestIds]);
      await client.query(`DELETE FROM guest_applications WHERE id = ANY($1)`, [guestIds]);
      await client.query(`DELETE FROM job_inactive_since WHERE job_id = ANY($1)`, [jobIds]);
      // job_applications.job_id cascades; job_submissions.job_id is set to NULL.
      jobsDeleted = (await client.query(`DELETE FROM jobs WHERE id = ANY($1) AND imported_from_live`, [jobIds])).rowCount ?? 0;
      await client.query(`ALTER TABLE guest_applications ENABLE TRIGGER guest_applications_keep_rows`);
      await client.query(`ALTER TABLE jobs ENABLE TRIGGER jobs_keep_applications`);
      await client.query(`ALTER TABLE jobs ENABLE TRIGGER jobs_imported_readonly`);
    }
    const details = { jobs: jobsDeleted, applications: appIds.length, guest_applications: guestIds.length };
    await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [PURGE_IMPORTED_JOBS_MIGRATION, JSON.stringify(details)]);
    await client.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ('system:migration', 'jobs.imported_purged', NULL, $1)`,
      [JSON.stringify(details)]);
    await client.query('COMMIT');
    console.log(`[migrate] imported jobs purged: ${details.jobs} jobs, ${details.applications} applications, ${details.guest_applications} quick applications`);
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * One-time (owner's decision, 17.11.2026, before Salesforce is connected): every candidate account (role 'user') is
 * removed from this site, with its applications (cascade), sign-in tokens, Salesforce queue rows and any forward of
 * its applications to an employer (the forwards trigger is off inside this transaction only). Their CV uploads are
 * released, so the regular stale-upload purge (s3Service.purgeStaleUploads) deletes the files once nothing points at
 * them. Nothing is deleted in Salesforce (it was off). Staff and employer accounts, quick applications and consent
 * records stay. Recorded in schema_migrations and the activity log (counts only); never runs twice.
 */
export const PURGE_CANDIDATES_MIGRATION = '2026-11-purge-candidate-accounts';
export const migratePurgeCandidateAccounts = async (): Promise<string> => {
  const done = await queryOne(`SELECT 1 FROM schema_migrations WHERE name = $1`, [PURGE_CANDIDATES_MIGRATION]);
  if (done) return 'already applied';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userIds: string[] = (await client.query(`SELECT id FROM users WHERE role = 'user'`)).rows.map((r) => r.id);
    const appIds: string[] = userIds.length
      ? (await client.query(`SELECT id FROM job_applications WHERE user_id = ANY($1)`, [userIds])).rows.map((r) => r.id) : [];
    let forwards = 0, released = 0, users = 0;
    if (userIds.length) {
      await client.query(`ALTER TABLE employer_forwards DISABLE TRIGGER employer_forwards_rules_rows`);
      forwards = (await client.query(
        `DELETE FROM employer_forwards WHERE kind = 'application' AND (candidate_id = ANY($1) OR application_id = ANY($2))`,
        [userIds, appIds])).rowCount ?? 0;
      await client.query(`ALTER TABLE employer_forwards ENABLE TRIGGER employer_forwards_rules_rows`);
      await client.query(
        `DELETE FROM salesforce_sync WHERE (kind = 'candidate' AND record_id = ANY($1)) OR (kind = 'application' AND record_id = ANY($2))`,
        [userIds, appIds]);
      await client.query(`DELETE FROM tokens WHERE user_id = ANY($1)`, [userIds]);
      released = (await client.query(
        `UPDATE cv_uploads SET claimed_by = NULL, created_at = now() - interval '7 days' WHERE claimed_by = ANY($1)`, [userIds])).rowCount ?? 0;
      users = (await client.query(`DELETE FROM users WHERE id = ANY($1) AND role = 'user'`, [userIds])).rowCount ?? 0;
    }
    const details = { candidates: users, applications: appIds.length, forwards, cv_uploads_released: released };
    await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [PURGE_CANDIDATES_MIGRATION, JSON.stringify(details)]);
    await client.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ('system:migration', 'users.candidates_purged', NULL, $1)`,
      [JSON.stringify(details)]);
    await client.query('COMMIT');
    console.log(`[migrate] candidate accounts purged: ${details.candidates} accounts, ${details.applications} applications, ${forwards} forwards, ${released} CV uploads released`);
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

/**
 * One-time (owner's decision, 17.11.2026, before Salesforce is switched on): the two test jobs created on this
 * platform while Salesforce was off (job numbers 1902, 1903) are removed by id, with what points at them (employer
 * link, edit requests, forwards, applications, quick applications, Salesforce queue rows), so every job the owner
 * creates from now on opens in Salesforce. Nothing is deleted in Salesforce (they were never sent). Recorded in
 * schema_migrations and the activity log (counts only); never runs twice.
 */
export const PURGE_TEST_JOBS_MIGRATION = '2026-11-purge-test-jobs';
const TEST_JOB_IDS = ['6afb018a659fda9f0462f1ce', '6afa16916214b9dad5051b12'];
export const migratePurgeTestJobs = async (): Promise<string> => {
  const done = await queryOne(`SELECT 1 FROM schema_migrations WHERE name = $1`, [PURGE_TEST_JOBS_MIGRATION]);
  if (done) return 'already applied';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobIds: string[] = (await client.query(`SELECT id FROM jobs WHERE id = ANY($1) AND NOT imported_from_live AND legacy_state IS NULL`, [TEST_JOB_IDS])).rows.map((r) => r.id);
    const appIds: string[] = jobIds.length
      ? (await client.query(`SELECT id FROM job_applications WHERE job_id = ANY($1)`, [jobIds])).rows.map((r) => r.id) : [];
    const guestIds: string[] = jobIds.length
      ? (await client.query(`SELECT id FROM guest_applications WHERE job_id = ANY($1)`, [jobIds])).rows.map((r) => r.id) : [];
    let jobs = 0;
    if (jobIds.length) {
      await client.query(`ALTER TABLE employer_forwards DISABLE TRIGGER employer_forwards_rules_rows`);
      await client.query(`ALTER TABLE guest_applications DISABLE TRIGGER guest_applications_keep_rows`);
      await client.query(`ALTER TABLE jobs DISABLE TRIGGER jobs_keep_applications`);
      await client.query(`DELETE FROM employer_forwards WHERE job_id = ANY($1)`, [jobIds]);
      await client.query(`DELETE FROM job_edit_requests WHERE job_id = ANY($1)`, [jobIds]);
      await client.query(`DELETE FROM employer_jobs WHERE job_id = ANY($1)`, [jobIds]);
      await client.query(
        `DELETE FROM salesforce_sync WHERE (kind = 'job' AND record_id = ANY($1)) OR (kind = 'application' AND record_id = ANY($2))
            OR (kind = 'guest_application' AND record_id = ANY($3))`, [jobIds, appIds, guestIds]);
      await client.query(`DELETE FROM guest_applications WHERE id = ANY($1)`, [guestIds]);
      await client.query(`DELETE FROM job_inactive_since WHERE job_id = ANY($1)`, [jobIds]);
      jobs = (await client.query(`DELETE FROM jobs WHERE id = ANY($1) AND NOT imported_from_live AND legacy_state IS NULL`, [jobIds])).rowCount ?? 0;
      await client.query(`ALTER TABLE jobs ENABLE TRIGGER jobs_keep_applications`);
      await client.query(`ALTER TABLE guest_applications ENABLE TRIGGER guest_applications_keep_rows`);
      await client.query(`ALTER TABLE employer_forwards ENABLE TRIGGER employer_forwards_rules_rows`);
    }
    const details = { jobs, applications: appIds.length, guest_applications: guestIds.length };
    await client.query(`INSERT INTO schema_migrations (name, details) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [PURGE_TEST_JOBS_MIGRATION, JSON.stringify(details)]);
    await client.query(`INSERT INTO audit_log (actor, action, target, details) VALUES ('system:migration', 'jobs.test_jobs_purged', NULL, $1)`,
      [JSON.stringify(details)]);
    await client.query('COMMIT');
    console.log(`[migrate] test jobs purged: ${jobs} jobs, ${details.applications} applications, ${details.guest_applications} quick applications`);
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

// The jobs that were on the existing site when it was copied here (seed/live-snapshot.json, the same file
// scripts/importFromLive.ts reads). Marked read-only on every migrate; a mark is never removed (the trigger).
const LIVE_SNAPSHOT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'live-snapshot.json');
export const markImportedJobs = async (): Promise<number> => {
  if (!fs.existsSync(LIVE_SNAPSHOT_FILE)) return 0;
  const jobs: any[] = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT_FILE, 'utf-8'))?.jobs?.data?.jobs ?? [];
  const ids = jobs.map((j) => String(j?._id ?? '')).filter((id) => /^[a-f0-9]{24}$/i.test(id));
  if (!ids.length) return 0;
  // A job read from the existing site's Salesforce (legacy_state) is not the local seed: never marked.
  const r = await pool.query(`UPDATE jobs SET imported_from_live = true WHERE id = ANY($1::text[]) AND NOT imported_from_live AND legacy_state IS NULL`, [ids]);
  if (r.rowCount) console.log(`[migrate] jobs from the existing site marked read-only: ${r.rowCount}`);
  return r.rowCount ?? 0;
};

// CBS settlement code -> [lat, lng] (see seed/build-settlement-coords.py).
const COORDS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'settlement-coords.json');

/**
 * Copies the bundled settlement coordinates onto the locations table. Idempotent
 * and cheap (one UPDATE); only rows whose point differs are written, so it runs
 * on every migrate and also backfills locations imported or synced later.
 */
export const backfillLocationCoords = async (): Promise<{ updated: number; withCoords: number; total: number }> => {
  if (!fs.existsSync(COORDS_FILE)) {
    console.warn(`[migrate] ${path.basename(COORDS_FILE)} not found; locations keep no coordinates`);
    return { updated: 0, withCoords: 0, total: 0 };
  }
  const settlements = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf-8')).settlements ?? {};
  const res = await pool.query(
    `UPDATE locations l SET lat = (e.value->>0)::float8, lng = (e.value->>1)::float8
       FROM jsonb_each($1::jsonb) e
      WHERE l.city_symbol = e.key::int
        AND (l.lat IS DISTINCT FROM (e.value->>0)::float8 OR l.lng IS DISTINCT FROM (e.value->>1)::float8)`,
    [JSON.stringify(settlements)]
  );
  const counts = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE lat IS NOT NULL)::int AS "withCoords", COUNT(*)::int AS total FROM locations WHERE city_symbol > 0`
  );
  return { updated: res.rowCount ?? 0, ...counts.rows[0] };
};

// The published privacy policy versions (server/privacy-versions/<id>.html, written by
// client/scripts/snapshot-privacy.tsx). Added once; an existing version is never changed (a different file for the
// same id is reported and ignored — publish a new version instead).
const PRIVACY_VERSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'privacy-versions');
export const registerPrivacyVersions = async (): Promise<string[]> => {
  if (!fs.existsSync(PRIVACY_VERSIONS_DIR)) return [];
  const added: string[] = [];
  for (const f of fs.readdirSync(PRIVACY_VERSIONS_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}[a-z0-9-]*\.html$/.test(x)).sort()) {
    const id = f.replace(/\.html$/, '');
    const content = fs.readFileSync(path.join(PRIVACY_VERSIONS_DIR, f), 'utf-8').replace(/\r\n/g, '\n'); // same on every checkout
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const r = await pool.query(`INSERT INTO privacy_versions (id, sha256, content) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, sha256, content]);
    if (r.rowCount) added.push(id);
    else {
      const old = await pool.query(`SELECT sha256 FROM privacy_versions WHERE id = $1`, [id]);
      if (old.rows[0]?.sha256 !== sha256) console.warn(`[migrate] privacy version ${id}: the file differs from the stored version; the stored one is kept`);
    }
  }
  if (added.length) console.log(`[migrate] privacy versions added: ${added.join(', ')}`);
  return added;
};

/** The lowest job number a job made on this site gets (JOB_NUMBER_FLOOR, default 3000; the existing site was at ~1910 in 11.2026). */
export const DEFAULT_JOB_NUMBER_FLOOR = 3000;
export const jobNumberFloor = (raw: string | undefined): number => {
  const n = Number(String(raw ?? '').trim() || DEFAULT_JOB_NUMBER_FLOOR);
  return Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : DEFAULT_JOB_NUMBER_FLOOR;
};

export const migrate = async () => {
  await pool.query(SCHEMA_SQL);
  await registerPrivacyVersions();
  await migrateRolesSplit();
  await migrateClearCandidatePasswords();
  await markImportedJobs();
  await migratePurgeImportedJobs();
  await migratePurgeCandidateAccounts();
  await migratePurgeTestJobs();
  await backfillLocationCoords();
  // Keep the job number sequence ahead of imported job numbers, and of the existing site's numbers (JOB_NUMBER_FLOOR):
  // a job made here never takes a number the existing site uses (its jobs keep theirs when they are read in).
  const floor = jobNumberFloor(process.env.JOB_NUMBER_FLOOR);
  await pool.query(
    `SELECT setval('jobs_job_id_seq', GREATEST((SELECT COALESCE(MAX(job_id), 0) FROM jobs), $1::int, 1),
                   (SELECT COUNT(*) > 0 FROM jobs) OR $1::int > 0)`, [floor]
  );
};
