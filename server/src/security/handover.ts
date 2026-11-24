/* ============================================================================
 *  Hand-overs of candidates' personal data to a content manager (or admin), or — for the applicants the SKEELZ
 *  team forwarded — to an employer (own budgets employerPeople / employerCvs, own actions employer.*). Every route that shows
 *  candidates (a list, someone's applications) or opens a CV goes through one
 *  of these, so it is (1) inside the daily limit, (2) recorded with the ids
 *  actually shown BEFORE the data leaves, (3) alerted at the threshold.
 *
 *  Project rule (CLAUDE.md): a new route that returns candidates must use
 *  peopleHandover; a new way to open a CV must use cvHandover.
 * ========================================================================== */
import { LimitError } from '../middleware/errorMiddleware.js';
import { Budget, LIMITS, allowance, capIds, countNewRows } from './pure.js';
import { writeAuditStrict } from './audit.js';
import { afterSpend, atLimit, dailyUsage, limitMessage, seenToday, withUserLock } from './limits.js';

/**
 * Shows people to `who` (the actor in the log). `budgetOwner` is whose daily allowance and alerts it is (an
 * internal API key → its issuer); defaults to `who`. `load` returns the rows; `idOf` names each row's person.
 * Rows of people not yet seen today are cut to what is left of the budget.
 */
export const peopleHandover = async <T>(opts: {
  who: string;
  budgetOwner?: string;
  action: 'candidates.shown' | 'candidate.applications_viewed' | 'employer.applicants_shown';
  /** 'people' (staff, default) or 'employerPeople' (an employer's forwarded applicants). */
  budget?: Extract<Budget, 'people' | 'employerPeople'>;
  place: string;
  details?: Record<string, unknown>;
  load: () => Promise<T[]>;
  idOf: (row: T) => string;
}): Promise<{ rows: T[]; cut: number }> => {
  const owner = opts.budgetOwner || opts.who;
  const budget = opts.budget ?? 'people';
  return withUserLock(budget, owner, async () => {
    const usage = await dailyUsage(owner, budget);
    const rows = await opts.load();
    const seen = await seenToday(owner);
    const ids = rows.map(opts.idOf);
    const fresh = countNewRows(ids, seen);
    if (fresh > 0 && usage.used >= usage.allowed) {
      await atLimit(owner, budget, opts.place, usage, opts.who);
      throw new LimitError(limitMessage(budget), budget);
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
      ...(owner !== opts.who ? { budget_owner: owner } : {}),
    });
    await afterSpend(owner, budget, usage.used, n);
    return { rows: kept, cut: rows.length - kept.length };
  });
};

/**
 * Opens a CV for `who`. `open` fetches it (the storage answered), then the
 * strict entry is written, and only then `deliver` sends it. If the entry
 * can't be written, `abort` drops the file and nothing is sent.
 */
export const cvHandover = async <F>(opts: {
  who: string;
  budgetOwner?: string;
  subjectId: string;
  place: string;
  /** 'cvs' + 'candidate.cv_opened' (staff, default) or 'employerCvs' + 'employer.cv_opened' (an employer). */
  budget?: Extract<Budget, 'cvs' | 'employerCvs'>;
  open: () => Promise<F>;
  abort: (file: F) => void;
  /** The candidate's id when only the opened file knows it (the employer's forward → its candidate). */
  subject?: (file: F) => string;
  details?: (file: F) => Record<string, unknown>;
}): Promise<F> => {
  const owner = opts.budgetOwner || opts.who;
  const budget = opts.budget ?? 'cvs';
  const action = budget === 'employerCvs' ? 'employer.cv_opened' : 'candidate.cv_opened';
  return withUserLock(budget, owner, async () => {
    const usage = await dailyUsage(owner, budget);
    if (usage.used >= usage.allowed) {
      await atLimit(owner, budget, opts.place, usage, opts.who);
      throw new LimitError(limitMessage(budget), budget);
    }
    const file = await opts.open();
    try {
      const subjectId = opts.subject ? opts.subject(file) : opts.subjectId;
      await writeAuditStrict(opts.who, action, subjectId, {
        ids: [subjectId], count: 1, via: opts.place, ...(opts.details?.(file) ?? {}),
        ...(owner !== opts.who ? { budget_owner: owner } : {}),
      });
    } catch (e) {
      opts.abort(file);
      throw e;
    }
    await afterSpend(owner, budget, usage.used, 1);
    return file;
  });
};

export { LIMITS };
