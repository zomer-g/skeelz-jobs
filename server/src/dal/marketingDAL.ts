/* ============================================================================
 *  Marketing consent and the removal list in the DB (security/marketing.ts has the rules, docs/marketing-consent.md
 *  the whole picture). Every change of a candidate's answer writes users AND a consent_records row in the same
 *  statement (consent_records is append-only). The removal list holds keyed hashes of addresses only.
 * ========================================================================== */
import { query, queryOne } from '../config/db.js';
import { normalizeEmail } from '../security/emailCode.js';
import { addressKey, addressKeys } from '../security/addressKey.js';
import { marketingStatus, MarketingStatus, OptoutVia, SOURCE_OF_VIA } from '../security/marketing.js';

/** key = the key a new row gets; keys = every key the address may be stored under (security/addressKey.ts). */
const keyOfUser = async (userId: string): Promise<{ key: string; keys: string[]; isCandidate: boolean } | null> => {
  const r = await queryOne<{ email: string; roles: string[] }>(`SELECT email, roles FROM users WHERE id = $1`, [userId]);
  return r ? { key: addressKey(r.email), keys: addressKeys(r.email), isCandidate: (r.roles ?? []).includes('user') } : null;
};

/**
 * The candidate's own answer in the personal area. "Yes" clears a removal (their own opt-in); "no" puts them on the
 * removal list (they asked to stop). false when the account is not a candidate.
 */
export const setOwnMarketing = async (userId: string, marketing: boolean, actor: string): Promise<boolean> => {
  const k = await keyOfUser(userId);
  if (!k?.isCandidate) return false;
  const rows = await query(
    `WITH u AS (
       UPDATE users SET marketing_consent = $2, marketing_consent_at = now(), marketing_consent_source = 'personal_area',
              marketing_optout_at = CASE WHEN $2 THEN NULL ELSE now() END, updated_at = now()
        WHERE id = $1 AND 'user' = ANY(roles) RETURNING id),
     c AS (INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
           SELECT 'user', u.id, NULL, $2, 'personal_area' FROM u),
     d AS (DELETE FROM marketing_optouts WHERE $2 AND email_key = ANY($5::text[]) AND EXISTS (SELECT 1 FROM u)),
     i AS (INSERT INTO marketing_optouts (email_key, user_id, via, actor)
           SELECT $3, u.id, 'personal_area', $4 FROM u WHERE NOT $2
           ON CONFLICT (email_key) DO UPDATE SET user_id = EXCLUDED.user_id, via = EXCLUDED.via, actor = EXCLUDED.actor, updated_at = now())
     SELECT id FROM u`, [userId, marketing, k.key, actor, k.keys]);
  return rows.length > 0;
};

/**
 * A removal: by the link in an email, staff on the person's request, or a spam complaint. Always wins over an earlier
 * "yes". `key` = addressKey of the address (or the key a link carries); `userId` = the candidate's account when known (its address must give the
 * same key — the caller checks). Returns the candidate id that was updated, if any.
 */
export const recordRemoval = async (target: { key: string; userId: string | null }, via: Exclude<OptoutVia, 'personal_area'>, actor: string): Promise<string | null> => {
  const rows = await query<{ user_id: string | null }>(
    `WITH o AS (INSERT INTO marketing_optouts (email_key, user_id, via, actor) VALUES ($1, $2, $3, $4)
                ON CONFLICT (email_key) DO UPDATE SET via = EXCLUDED.via, actor = EXCLUDED.actor,
                  user_id = COALESCE(EXCLUDED.user_id, marketing_optouts.user_id), updated_at = now()
                RETURNING email_key),
     u AS (UPDATE users SET marketing_consent = false, marketing_consent_at = now(), marketing_consent_source = $5,
                  marketing_optout_at = COALESCE(marketing_optout_at, now()), updated_at = now()
            WHERE $2::text IS NOT NULL AND id = $2 AND 'user' = ANY(roles) RETURNING id),
     c AS (INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
           SELECT 'user', u.id, NULL, false, $5 FROM u)
     SELECT (SELECT id FROM u) AS user_id, (SELECT count(*) FROM o) AS n`,
    [target.key, target.userId, via, actor, SOURCE_OF_VIA[via]]);
  return rows[0]?.user_id ?? null;
};

/** The candidate account of an address (lower-case match), for a removal that came with an address. */
export const candidateIdByEmail = async (email: string): Promise<string | null> =>
  (await queryOne<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1 AND 'user' = ANY(roles)`, [normalizeEmail(email)]))?.id ?? null;

/** Does this account's address still give this key (the address may have changed since the link was sent)? */
export const userHasKey = async (userId: string, key: string): Promise<boolean> => !!(await keyOfUser(userId))?.keys.includes(key);

/**
 * Right after an account gets the candidate role (sign-up, role added): its own verified "yes" clears an earlier
 * removal of that address; otherwise an earlier removal of the address now shows on the account.
 */
export const linkRemovalToNewCandidate = async (userId: string, email: string, saidYes: boolean): Promise<void> => {
  const keys = addressKeys(email);
  if (saidYes) {
    await query(`DELETE FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [keys]);
    return;
  }
  await query(
    `WITH o AS (UPDATE marketing_optouts SET user_id = $2, updated_at = now() WHERE email_key = ANY($1::text[]) RETURNING created_at)
     UPDATE users SET marketing_optout_at = (SELECT min(created_at) FROM o) WHERE id = $2 AND EXISTS (SELECT 1 FROM o)`, [keys, userId]);
};

/** A candidate's own "yes" on a form (apply): clears a removal of their address. */
export const ownYesClearsRemoval = async (userId: string): Promise<void> => {
  const k = await keyOfUser(userId);
  if (!k) return;
  await query(`DELETE FROM marketing_optouts WHERE email_key = ANY($1::text[])`, [k.keys]);
  await query(`UPDATE users SET marketing_optout_at = NULL WHERE id = $1`, [userId]);
};

export interface MarketingView {
  status: MarketingStatus;
  at: Date | null;
  source: string | null;
  removal: { at: Date; via: OptoutVia } | null;
  history: { at: Date; marketing: boolean; source: string }[];
}

/** One candidate: the current state and every answer (ids and sources only; for the staff screen). */
export const marketingOf = async (userId: string): Promise<MarketingView | null> => {
  const u = await queryOne<{ email: string; marketing_consent: boolean | null; marketing_consent_at: Date | null; marketing_consent_source: string | null; marketing_optout_at: Date | null }>(
    `SELECT email, marketing_consent, marketing_consent_at, marketing_consent_source, marketing_optout_at FROM users WHERE id = $1 AND 'user' = ANY(roles)`, [userId]);
  if (!u) return null;
  const o = await queryOne<{ created_at: Date; updated_at: Date; via: OptoutVia }>(`SELECT created_at, updated_at, via FROM marketing_optouts WHERE email_key = ANY($1::text[]) ORDER BY updated_at DESC LIMIT 1`, [addressKeys(u.email)]);
  const history = await query<{ at: Date; marketing: boolean; source: string }>(
    `SELECT at, marketing, source FROM consent_records WHERE subject_kind = 'user' AND subject_id = $1 AND marketing IS NOT NULL
      ORDER BY at DESC, id DESC LIMIT 100`, [userId]);
  return {
    status: marketingStatus(u.marketing_consent, u.marketing_optout_at),
    at: u.marketing_consent_at, source: u.marketing_consent_source,
    removal: u.marketing_optout_at && o ? { at: o.updated_at, via: o.via } : null,
    history,
  };
};

/** SQL for the candidates list filter (security/marketing.ts states). */
export const STATUS_SQL: Record<MarketingStatus, string> = {
  removed: `u.marketing_optout_at IS NOT NULL`,
  agreed: `u.marketing_optout_at IS NULL AND u.marketing_consent IS TRUE`,
  not_agreed: `u.marketing_optout_at IS NULL AND u.marketing_consent IS FALSE`,
  unknown: `u.marketing_optout_at IS NULL AND u.marketing_consent IS NULL`,
};
