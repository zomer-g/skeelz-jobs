// "Continue with Google" is xhostd SSO, and staff sign in only that way, so the local e2e scripts sign in through
// the real /api/auth/xhostd/* routes with a mock xhostd: the test plays xhostd's part by setting the identity
// cookie (__Host-xhost_id) that xhostd's edge would set, signed by the mock provider's key.
//
// The local server must trust the mock (DEV_MODE only):
//   SSO_ENABLED=true SSO_ISSUER=http://127.0.0.1:3199 SSO_JWKS_URL=http://127.0.0.1:3199/jwks
import crypto from 'node:crypto';
import { startMockIdp } from './mockIdp.mjs';

export const MOCK_IDP_PORT = Number(process.env.MOCK_IDP_PORT || 3199);

let shared = null;
/** One mock provider per test process, on the port the server was told to trust. */
export const mockIdp = async () => (shared ??= await startMockIdp({ port: MOCK_IDP_PORT }));

/** Stable fake xhostd subject for an email (the real one is the Google account id). */
export const subFor = (email) => `xh-${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 20)}`;

/**
 * Full xhostd SSO sign-in for a jar client (needs client.setCookie). Returns the callback response
 * (302 to ?signin=ok or ?signin_error=<code>).
 */
export const xhostdSignIn = async (client, email, { sub = subFor(email), host = 'localhost', claims = {}, returnTo = '/' } = {}) => {
  const idp = await mockIdp();
  const start = await client.req('GET', `/api/auth/xhostd/start?return_to=${encodeURIComponent(returnTo)}`);
  if (start.status !== 302) throw new Error(`xhostd start answered ${start.status}`);
  const back = new URL(start.headers.get('location'), 'http://placeholder').searchParams.get('return_to');
  if (!back) throw new Error(`xhostd start did not redirect to the SSO login: ${start.headers.get('location')}`);
  client.setCookie('__Host-xhost_id', idp.sign({ aud: host, sub, email, name: 'Test Staff', ...claims }));
  return client.req('GET', back);
};

export const signedInOk = (res) => res.status === 302 && /[?&]signin=ok\b/.test(res.headers.get('location') || '');
export const signInError = (res) => new URL(res.headers.get('location') || '/', 'http://placeholder').searchParams.get('signin_error');

/**
 * Drop-in for the old staff password login in the e2e scripts: SSO sign-in, then the session, shaped like the
 * POST /api/login answer ({ status, json: { data: { user, jobApplicationsId } } }).
 */
export const staffLogin = async (client, email) => {
  const r = await xhostdSignIn(client, email);
  if (!signedInOk(r)) return { status: 401, json: { code: signInError(r) }, text: String(r.headers.get('location')) };
  const s = await client.req('GET', '/api/auth/session');
  return { status: s.json?.data ? 200 : 401, json: s.json, text: s.text };
};
