/* ============================================================================
 *  Daily limits per content manager, counted FROM THE ACTIVITY LOG (no separate counter
 *  that can drift): used today = sum(details.count) of the person's counted
 *  actions since midnight Israel time; allowed = daily + today's grants.
 *
 *  check → work → strict log runs under a per-person lock (withUserLock), so
 *  parallel requests cannot spend the same allowance twice. The app is ONE
 *  Node process on xhostd, so an in-process lock is exact; if it ever runs as
 *  several processes, replace it with pg_advisory_xact_lock on a direct
 *  connection (see the app-security-baseline skill).
 * ========================================================================== */
import { query, queryOne } from '../config/db.js';
import { BUDGET_ACTIONS, Budget, LIMITS, SEEN_ACTIONS, crossesAlert, israelDay, israelMidnight } from './pure.js';
import { writeAudit } from './audit.js';

const chains = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with the same key has finished. */
export const withUserLock = async <T>(budget: Budget, who: string, fn: () => Promise<T>): Promise<T> => {
  const key = `${budget}:${who.toLowerCase()}`;
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  chains.set(key, chain);
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (chains.get(key) === chain) chains.delete(key);
  }
};

export type Usage = { budget: Budget; used: number; allowed: number; granted: number; day: string };

export const dailyUsage = async (who: string, budget: Budget, now = new Date()): Promise<Usage> => {
  const day = israelDay(now);
  const since = israelMidnight(day);
  const [u, g] = await Promise.all([
    queryOne<{ n: number }>(
      `SELECT COALESCE(SUM(CASE WHEN details ? 'count' THEN (details->>'count')::int ELSE 0 END), 0)::int AS n
         FROM audit_log WHERE actor = $1 AND at >= $2 AND action = ANY($3)`,
      [who, since, BUDGET_ACTIONS[budget]]
    ),
    queryOne<{ n: number }>(
      `SELECT COALESCE(SUM(extra), 0)::int AS n FROM quota_grants WHERE lower(user_email) = lower($1) AND day = $2 AND budget = $3`,
      [who, day, budget]
    ),
  ]);
  const granted = g?.n ?? 0;
  return { budget, used: u?.n ?? 0, allowed: LIMITS[budget].daily + granted, granted, day };
};

/** Ids this person was already shown today (each candidate counts once a day). */
export const seenToday = async (who: string, now = new Date()): Promise<Set<string>> => {
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(details->'ids') AS id FROM audit_log
      WHERE actor = $1 AND at >= $2 AND action = ANY($3) AND details ? 'ids'`,
    [who, israelMidnight(israelDay(now)), SEEN_ACTIONS]
  );
  return new Set(rows.map((r) => r.id));
};

/** Raises an alert once per (kind, person, day, threshold). */
export const raiseAlert = async (kind: string, who: string, threshold: number, details: Record<string, unknown> = {}) => {
  try {
    const rows = await query(
      `INSERT INTO security_alerts (kind, user_email, day, threshold, details) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (kind, user_email, day, threshold) DO NOTHING RETURNING id`,
      [kind, who, israelDay(), threshold, JSON.stringify(details)]
    );
    if (rows.length) void writeAudit('system:limits', 'security.alert_raised', who, { kind, threshold, ...details });
  } catch (e) {
    console.error('[limits] could not raise an alert', (e as Error).message);
  }
};

/** After a counted spend: alert when it crossed the line. */
export const afterSpend = async (who: string, budget: Budget, usedBefore: number, n: number) => {
  if (crossesAlert(usedBefore, n, LIMITS[budget].alertAt)) {
    await raiseAlert(`${budget}_many`, who, LIMITS[budget].alertAt, { used: usedBefore + n });
  }
};

/** At the wall: alert "wants more" once a day, one refusal entry per place a day. */
const refusalsLogged = new Set<string>();
export const atLimit = async (who: string, budget: Budget, place: string, usage: Usage) => {
  await raiseAlert(`${budget}_limit`, who, usage.allowed, { used: usage.used, place });
  const k = `${usage.day}|${who}|${budget}|${place}`;
  if (!refusalsLogged.has(k)) {
    refusalsLogged.add(k);
    void writeAudit(who, 'limits.refused', place, { budget, used: usage.used, allowed: usage.allowed });
  }
};

export const limitMessage = (budget: Budget) =>
  budget === 'cvs'
    ? `הגעת למגבלה היומית של ${LIMITS.cvs.daily} קורות חיים. מנהל מערכת קיבל התראה ויכול לאשר עוד ${LIMITS.cvs.grant}.`
    : `הגעת למגבלה היומית של ${LIMITS.people.daily} מועמדים שהוצגו. מנהל מערכת קיבל התראה ויכול לאשר עוד ${LIMITS.people.grant}.`;
