/**
 * Board placement rules for jobs (jobs-management screen): pin to top (הקפצה), public/private,
 * sponsored (crown), publish date incl. scheduled publishing, soft delete (archive).
 * Pure: no DB, no clock except the `now` passed in. Tested in test/unit/jobBoard.test.ts.
 * Described for people in docs/jobs-management.md.
 */

/** Public ordering, everywhere jobs are listed publicly (board, map search list, public API, MCP):
 *  1. pinned jobs first, the most recently pinned on top (a new "bump" goes above older pins);
 *  2. then everything else by publish date, newest first;
 *  3. ties: id descending (stable paging).
 *  The map search keeps this order as well (pinned first, then nearest; see jobDAL.findActiveJobsNear). */
export const PUBLIC_ORDER_SQL = (a = 'j') => `${a}.pinned_at DESC NULLS LAST, ${a}.publish_date DESC, ${a}.id DESC`;

/** Who the public may see, everywhere (board, map, job lists, public API, MCP, a sitemap if one is added):
 *  Active, public (not private), not archived, and the publish date has come (scheduled jobs wait). */
export const PUBLIC_LISTING_SQL = (a = 'j') =>
  `${a}.status = 'Active' AND ${a}.is_public = true AND ${a}.deleted_at IS NULL AND ${a}.publish_date <= now()`;

/** A direct link /job/:id (and applying) works for Active, not archived, already published jobs.
 *  Private jobs are "unlisted": not in any list or API, but the direct link still opens and accepts
 *  applications, so a content manager can share it with chosen people. */
export interface BoardState {
  status: string;
  isPublic?: boolean;
  deletedAt?: Date | string | null;
  publishDate?: Date | string | null;
  pinnedAt?: Date | string | null;
  id?: string;
}

const t = (d: Date | string | null | undefined) => (d === null || d === undefined ? NaN : new Date(d).getTime());

export const isPublished = (job: BoardState, now: Date) => {
  const p = t(job.publishDate);
  return Number.isFinite(p) && p <= now.getTime();
};

/** On the board / public API / MCP. Same rule as PUBLIC_LISTING_SQL. */
export const isPubliclyListed = (job: BoardState | null | undefined, now: Date = new Date()) =>
  !!job && job.status === 'Active' && job.isPublic !== false && !job.deletedAt && isPublished(job, now);

/** Opens by direct link / accepts applications (private allowed). */
export const isOpenByLink = (job: BoardState | null | undefined, now: Date = new Date()) =>
  !!job && job.status === 'Active' && !job.deletedAt && isPublished(job, now);

/** JS twin of PUBLIC_ORDER_SQL (tests, and anywhere a list is merged in memory). */
export const comparePublicOrder = (a: BoardState, b: BoardState) => {
  const pa = t(a.pinnedAt), pb = t(b.pinnedAt);
  const ap = Number.isFinite(pa), bp = Number.isFinite(pb);
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && bp && pa !== pb) return pb - pa;
  const da = t(a.publishDate), db = t(b.publishDate);
  if (da !== db) return (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);
  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
};

// ---- publish date ----
export const PUBLISH_DATE_RULES = {
  /** Earliest accepted publish date. */
  earliest: '2015-01-01T00:00:00.000Z',
  /** A date this far ahead is still "now" (clock skew, the time it takes to fill the form). */
  graceMinutes: 10,
  /** Scheduled publishing: at most this many days ahead. */
  maxScheduleDays: 365,
} as const;

export type PublishDateCheck =
  | { ok: true; date: Date; scheduled: boolean }
  | { ok: false; code: 'invalid' | 'too_early' | 'future_needs_schedule' | 'too_far' };

/** Validates a publish date. A future date is accepted only when the caller says it is meant as
 *  scheduled publishing (`schedule: true`); the job then stays hidden from the public until that date. */
export const checkPublishDate = (value: unknown, now: Date, schedule = false): PublishDateCheck => {
  if (value === null || value === undefined || value === '') return { ok: false, code: 'invalid' };
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
  if (!Number.isFinite(d.getTime())) return { ok: false, code: 'invalid' };
  if (d.getTime() < new Date(PUBLISH_DATE_RULES.earliest).getTime()) return { ok: false, code: 'too_early' };
  const future = d.getTime() > now.getTime() + PUBLISH_DATE_RULES.graceMinutes * 60_000;
  if (!future) return { ok: true, date: d, scheduled: false };
  if (!schedule) return { ok: false, code: 'future_needs_schedule' };
  if (d.getTime() > now.getTime() + PUBLISH_DATE_RULES.maxScheduleDays * 86_400_000) return { ok: false, code: 'too_far' };
  return { ok: true, date: d, scheduled: true };
};

// ---- integrations (internal API, Salesforce, imports) ----
/** Board fields a content manager sets on the jobs-management screen. Once set there, they are
 *  recorded in jobs.managed_fields and no integration may overwrite them (internal API / Salesforce
 *  flows / import scripts). Pin, visibility and archive are never settable by integrations at all. */
export const MANAGED_FIELDS = ['isSponsored', 'publishDate'] as const;
export const SCREEN_ONLY_FIELDS = ['pinnedAt', 'isPublic', 'deletedAt'] as const;

/** Removes from an integration's update what the screen owns. Returns what was dropped (names only). */
export const stripManagedFields = <T extends Record<string, any>>(dto: T, managed: string[] | null | undefined) => {
  const out: Record<string, any> = { ...dto };
  const ignored: string[] = [];
  const owned = new Set<string>([...SCREEN_ONLY_FIELDS, ...(managed ?? []).filter((f) => (MANAGED_FIELDS as readonly string[]).includes(f))]);
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) { delete out[k]; continue; } // DTO instances carry every declared key
    if (owned.has(k)) { delete out[k]; ignored.push(k); }
  }
  return { dto: out as Partial<T>, ignored };
};

/** Admin list filters (jobs-management screen). */
export interface BoardFilters {
  visibility?: 'public' | 'private';
  pinned?: boolean;
  archived?: 'only' | 'include';
  scheduled?: boolean;
}
