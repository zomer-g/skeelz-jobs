// What to tell a candidate when an application did not go through (owner, 23.11.2026: never "try again" for a
// refusal that trying again won't fix). The API layer already turns the server's code into Hebrew
// (GlobalApi.generalRequest: the server's own message for job_on_existing_site / candidate_read_only /
// threshold_not_confirmed / limit_*, the error map for jb3 already applied, jb11 CV required, jb13 the same address
// already applied, rl1 too many requests); JobService returns its own text when the candidate cancelled the
// threshold or consent dialog. Only a network failure or an unknown error keeps the "try again" text.
import { i18n } from '../i18n/I18n';
import { lastApiErrorCode } from './lastApiError';

const UNKNOWN_CODES = new Set(['network', 'UnknownError', 'jb4', 'jb9', 'ge1']);

export function applyErrorText(result: string, tryAgain: string): string {
  const code = lastApiErrorCode();
  const generic = i18n.getTranslations().GlobalErrors.GENERAL_ERROR;
  if (!result || result === generic || (code !== null && UNKNOWN_CODES.has(code))) return tryAgain;
  return result;
}
