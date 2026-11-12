import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','content_manager','user'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS users_staff_idx ON users (role) WHERE role <> 'user';

-- One-time data migrations that must not repeat (see migrate()).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name     text PRIMARY KEY,
  applied  timestamptz NOT NULL DEFAULT now(),
  details  jsonb
);

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
-- is_public  = false: private (unlisted) — not on the board, map, public API or MCP; the direct link still works.
-- deleted_at = soft delete (archive); restore clears it. Applications are never deleted with a job.
-- managed_fields = board fields set on the management screen; integrations (internal API, Salesforce) don't overwrite them.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS managed_fields text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS jobs_pinned_idx ON jobs (pinned_at DESC) WHERE pinned_at IS NOT NULL;
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

-- "Continue with Google" = xhostd SSO (config/ssoConfig.ts). xhostd_sub: the stable Google id xhostd signs,
-- linked to a candidate or a staff account. It never grants a role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS xhostd_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS users_xhostd_sub_idx ON users (xhostd_sub) WHERE xhostd_sub IS NOT NULL;
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

export const migrate = async () => {
  await pool.query(SCHEMA_SQL);
  await migrateRolesSplit();
  await backfillLocationCoords();
  // Keep the job number sequence ahead of imported job numbers.
  await pool.query(
    `SELECT setval('jobs_job_id_seq', GREATEST((SELECT COALESCE(MAX(job_id), 0) FROM jobs), 1),
                   (SELECT COUNT(*) > 0 FROM jobs))`
  );
};
