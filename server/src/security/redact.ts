/* ============================================================================
 *  Imported FIRST by index.ts: no personal data in the server's console log.
 *  DB driver errors carry the SQL values (a searched name, "Key (email)=(…)");
 *  Salesforce/SMOOV errors echo the request. Every console.log/warn/error
 *  argument is printed safely: errors as their kind/code, text with emails and
 *  phone numbers masked, objects stringified and masked.
 * ========================================================================== */
import { redactText, safeErrorText } from './pure.js';

const safeArg = (a: unknown): unknown => {
  if (a == null || typeof a === 'number' || typeof a === 'boolean') return a;
  if (typeof a === 'string') return redactText(a);
  if (a instanceof Error || (typeof a === 'object' && ((a as any).isAxiosError || 'severity' in (a as any)))) return safeErrorText(a);
  try {
    const s = JSON.stringify(a);
    return redactText(s.length > 2000 ? `${s.slice(0, 2000)}…` : s);
  } catch {
    return '[unprintable]';
  }
};

for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => original(...args.map(safeArg));
}
