// The code (not the message) of the last API error, for analytics: GlobalApi.generalRequest turns errors into
// Hebrew text, so the code is kept here for whoever needs to know WHY a request failed (utils/analytics.ts
// apiErrorCode). Codes only — e.g. 'threshold_not_confirmed', 'jb11', 'limit_people' — never message text.
let last: string | null = null;

export const setLastApiErrorCode = (code: unknown) => {
  last = typeof code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(code) ? code : null;
};
export const lastApiErrorCode = (): string | null => last;
