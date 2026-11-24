/** "The public job list changed": index.ts keeps a short cache of the page data and drops it on this signal. */
const listeners = new Set<() => void>();
export const onJobsChanged = (fn: () => void) => { listeners.add(fn); };
export const jobsChanged = () => { for (const fn of listeners) fn(); };
