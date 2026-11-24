/* ============================================================================
 *  Salesforce REST client: Client Credentials token (External Client App, "Run
 *  As" the integration user), cached and shared by concurrent calls.
 *
 *  - The secret travels in the POST body, never in a URL.
 *  - The token is renewed every TOKEN_TTL_MS; the old one is revoked first, so a
 *    Permission Set change takes effect within that time (Salesforce keeps the
 *    permissions a session had when it opened).
 *  - A 401 drops the token and retries the call once with a new one.
 *  - Nothing here logs a response body, a token or the secret; failures surface
 *    as SalesforceAuthError (code = the OAuth error code, e.g. invalid_client)
 *    or as the axios error (callers keep only salesforceErrorCode()).
 * ========================================================================== */
import axios, { AxiosRequestConfig, Method } from 'axios';
import appConfig from './appConfig.js';

export interface SalesforceAuth {
  access_token: string;
  instance_url: string;
}

export class SalesforceAuthError extends Error {
  constructor(public code: string) { super(`Salesforce authentication failed (${code})`); this.name = 'SalesforceAuthError'; }
}

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 30_000;

let cached: { auth: SalesforceAuth; at: number } | null = null;
let inflight: Promise<SalesforceAuth> | null = null;

const oauthCode = (e: any): string => {
  const c = e?.response?.data?.error;
  if (typeof c === 'string' && /^[a-z_]{3,40}$/.test(c)) return c;
  if (typeof e?.response?.status === 'number') return `http_${e.response.status}`;
  if (typeof e?.code === 'string' && /^[A-Z_]{3,40}$/.test(e.code)) return `net_${e.code}`;
  return 'error';
};

const revoke = async (token: string) => {
  const { loginUrl } = appConfig.salesforce;
  await axios.post(`${loginUrl}/services/oauth2/revoke`, new URLSearchParams({ token }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000,
  }).catch(() => undefined); // best effort: an expired token is fine
};

const requestToken = async (): Promise<SalesforceAuth> => {
  const { clientId, clientSecret, loginUrl } = appConfig.salesforce;
  if (!clientId || !clientSecret || !loginUrl) throw new SalesforceAuthError('not_configured');
  try {
    const r = await axios.post(`${loginUrl}/services/oauth2/token`,
      new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_MS });
    const { access_token, instance_url } = r.data ?? {};
    if (typeof access_token !== 'string' || typeof instance_url !== 'string' || !/^https?:\/\//.test(instance_url)) {
      throw new SalesforceAuthError('bad_token_response');
    }
    return { access_token, instance_url: instance_url.replace(/\/+$/, '') };
  } catch (e) {
    if (e instanceof SalesforceAuthError) throw e;
    throw new SalesforceAuthError(oauthCode(e));
  }
};

/** A valid token (cached; renewed after TOKEN_TTL_MS, revoking the old one first). */
export const getSalesforceConfig = async (opts: { fresh?: boolean } = {}): Promise<SalesforceAuth> => {
  if (!opts.fresh && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.auth;
  if (inflight) return inflight;
  const old = cached?.auth.access_token;
  cached = null;
  inflight = (async () => {
    try {
      if (old) await revoke(old);
      const auth = await requestToken();
      cached = { auth, at: Date.now() };
      return auth;
    } finally { inflight = null; }
  })();
  return inflight;
};

/** Forget the cached token (tests, and after a 401). */
export const resetSalesforceToken = () => { cached = null; };

/**
 * One REST call under /services/data/<version>/ (or an absolute /services/... path). Retries once on 401 with a new
 * token. Returns the response data.
 */
export const sfRequest = async <T = any>(method: Method, path: string, data?: unknown, extra: AxiosRequestConfig = {}): Promise<T> => {
  const url = (auth: SalesforceAuth) =>
    `${auth.instance_url}${path.startsWith('/services/') ? path : `/services/data/${appConfig.salesforce.apiVersion}/${path.replace(/^\/+/, '')}`}`;
  const call = (auth: SalesforceAuth) => axios.request<T>({
    method, url: url(auth), data, timeout: TIMEOUT_MS, ...extra,
    headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', ...(extra.headers ?? {}) },
  });
  let auth = await getSalesforceConfig();
  try {
    return (await call(auth)).data;
  } catch (e: any) {
    if (e?.response?.status !== 401) throw e;
    resetSalesforceToken();
    auth = await getSalesforceConfig({ fresh: true });
    return (await call(auth)).data;
  }
};

/** SOQL query; only the first page (our queries ask for a handful of rows). */
export const sfQuery = async <T = any>(soql: string): Promise<T[]> =>
  (await sfRequest<{ records?: T[] }>('GET', `query?q=${encodeURIComponent(soql)}`)).records ?? [];

/**
 * SOQL query, every page (Salesforce answers 200–2000 rows a page and a nextRecordsUrl), up to `max` rows. Read only.
 * Used by the existing site's jobs mirror (services/legacyJobs.ts).
 */
export const sfQueryAll = async <T = any>(soql: string, max = 20_000): Promise<{ records: T[]; truncated: boolean }> => {
  type Page = { records?: T[]; done?: boolean; nextRecordsUrl?: string };
  const out: T[] = [];
  let page = await sfRequest<Page>('GET', `query?q=${encodeURIComponent(soql)}`);
  let truncated = false;
  for (;;) {
    out.push(...(page.records ?? []));
    if (page.done !== false || !page.nextRecordsUrl) break;
    // Only a path of this org's query API is followed (never a host from the answer).
    if (out.length >= max || !/^\/services\/data\/v\d+\.0\/query\/[A-Za-z0-9-]+$/.test(page.nextRecordsUrl)) { truncated = true; break; }
    page = await sfRequest<Page>('GET', page.nextRecordsUrl);
  }
  return { records: out.slice(0, max), truncated: truncated || out.length > max };
};
