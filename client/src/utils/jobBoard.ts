// Board placement helpers for the jobs-management screen (rules: server/src/models/schemas/jobBoard.ts).

/** Same grace as the server: a date up to 10 minutes ahead is still "now". */
const GRACE_MS = 10 * 60_000;
export const MAX_SCHEDULE_DAYS = 365;

const pad = (n: number) => String(n).padStart(2, '0');

/** Date -> value of <input type="date"> (local day). */
export const toDateInput = (d?: Date | string | null): string => {
  if (!d) return '';
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return '';
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

/** <input type="date"> value -> the publish moment: today = now; another day = that day's start (local). */
export const fromDateInput = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(d.getTime())) return null;
  return toDateInput(d) === toDateInput(new Date()) ? new Date() : d;
};

export const isFutureDate = (d?: Date | string | null) => !!d && new Date(d).getTime() > Date.now() + GRACE_MS;

export const maxScheduleInput = () => toDateInput(new Date(Date.now() + MAX_SCHEDULE_DAYS * 86_400_000));

export const formatDay = (d?: Date | string | null) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isFinite(x.getTime()) ? `${pad(x.getDate())}/${pad(x.getMonth() + 1)}/${x.getFullYear()}` : '';
};
