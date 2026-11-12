/* ============================================================================
 *  Hand-overs of candidates' personal data to a content manager. Every route that shows
 *  candidates (a list, someone's applications) or opens a CV goes through one
 *  of these, so it is (1) inside the daily limit, (2) recorded with the ids
 *  actually shown BEFORE the data leaves, (3) alerted at the threshold.
 *
 *  Project rule (CLAUDE.md): a new route that returns candidates must use
 *  peopleHandover; a new way to open a CV must use cvHandover.
 * ========================================================================== */
import { LimitError } from '../middleware/errorMiddleware.js';
import { LIMITS, allowance, capIds, countNewRows } from './pure.js';
import { writeAuditStrict } from './audit.js';
import { afterSpend, atLimit, dailyUsage, limitMessage, seenToday, withUserLock } from './limits.js';

/**
 * Shows people to `who`. `load` returns the rows; `idOf` names each row's person.
 * Rows of people not yet seen today are cut to what is left of the budget.
 */
export const peopleHandover = async <T>(opts: {
  who: string;
  action: 'candidates.shown' | 'candidate.applications_viewed';
  place: string;
  details?: Record<string, unknown>;
  load: () => Promise<T[]>;
  idOf: (row: T) => string;
}): Promise<{ rows: T[]; cut: number }> =>
  withUserLock('people', opts.who, async () => {
    const usage = await dailyUsage(opts.who, 'people');
    const rows = await opts.load();
    const seen = await seenToday(opts.who);
    const ids = rows.map(opts.idOf);
    const fresh = countNewRows(ids, seen);
    if (fresh > 0 && usage.used >= usage.allowed) {
      await atLimit(opts.who, 'people', opts.place, usage);
      throw new LimitError(limitMessage('people'), 'people');
    }
    // Keep everyone already seen today, plus as many new people as still fit.
    let room = allowance(usage.used, usage.allowed, fresh);
    const kept = rows.filter((r) => {
      const id = opts.idOf(r);
      if (seen.has(id)) return true;
      if (room > 0) { room--; seen.add(id); return true; }
      return false;
    });
    const keptIds = kept.map(opts.idOf);
    const n = Math.min(fresh, allowance(usage.used, usage.allowed, fresh));
    await writeAuditStrict(opts.who, opts.action, opts.place, {
      ...(opts.details ?? {}), ...capIds(keptIds), count: n, shown: kept.length, cut: rows.length - kept.length,
    });
    await afterSpend(opts.who, 'people', usage.used, n);
    return { rows: kept, cut: rows.length - kept.length };
  });

/**
 * Opens a CV for `who`. `open` fetches it (the storage answered), then the
 * strict entry is written, and only then `deliver` sends it. If the entry
 * can't be written, `abort` drops the file and nothing is sent.
 */
export const cvHandover = async <F>(opts: {
  who: string;
  subjectId: string;
  place: string;
  open: () => Promise<F>;
  abort: (file: F) => void;
  details?: (file: F) => Record<string, unknown>;
}): Promise<F> =>
  withUserLock('cvs', opts.who, async () => {
    const usage = await dailyUsage(opts.who, 'cvs');
    if (usage.used >= usage.allowed) {
      await atLimit(opts.who, 'cvs', opts.place, usage);
      throw new LimitError(limitMessage('cvs'), 'cvs');
    }
    const file = await opts.open();
    try {
      await writeAuditStrict(opts.who, 'candidate.cv_opened', opts.subjectId, {
        ids: [opts.subjectId], count: 1, via: opts.place, ...(opts.details?.(file) ?? {}),
      });
    } catch (e) {
      opts.abort(file);
      throw e;
    }
    await afterSpend(opts.who, 'cvs', usage.used, 1);
    return file;
  });

export { LIMITS };
