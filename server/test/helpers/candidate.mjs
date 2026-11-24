// Candidates have no password (since 11.2026): they sign in with a one-time code sent by email (or Google).
// The e2e scripts get the code from the DEV_MODE-only endpoint POST /api/dev/email-code (never mounted in production)
// instead of an inbox, then use the real /api/auth/email/verify and /api/auth/email/signup routes.
//
// `client` is any of the scripts' cookie jars: { req(method, path, body) → { status, json, text, headers } }.

/** A fresh code for the address, without the per-address limits (dev only). */
export const devCode = async (client, email) => {
  const r = await client.req('POST', '/api/dev/email-code', { email });
  if (r.status !== 200 || !r.json?.data?.code) throw new Error(`dev email code: ${r.status} ${r.text} (is DEV_MODE=true?)`);
  return r.json.data.code;
};

/** The last code the real request route sent to that address (dev only), or null. */
export const lastSentCode = async (client, email) => {
  const r = await client.req('GET', `/api/dev/email-code?email=${encodeURIComponent(email)}`);
  return r.status === 200 ? r.json?.data?.code ?? null : null;
};

/**
 * Sign-up as the old POST /api/users did: code → verify (a new address opens the sign-up form) → the form.
 * Returns the form's answer, with `data._id` added, so `{ status, json: { data: { _id, user } } }` as before.
 * An address that already has an account answers 400 `us2` (and that client is now signed in to it).
 */
export const signUp = async (client, body) => {
  const email = String(body?.email ?? '');
  const code = await devCode(client, email);
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  if (v.status !== 200) return v;
  if (v.json?.data?.status !== 'signup') return { status: 400, json: { code: 'us2', message: 'email exists' }, text: 'email exists', headers: v.headers };
  const r = await client.req('POST', '/api/auth/email/signup', body);
  if (r.status === 200 && r.json?.data?.user) r.json.data._id = r.json.data.user._id ?? r.json.data.user.id;
  return r;
};

/**
 * Sign-in of an existing candidate (the old POST /api/login with a password): code → verify.
 * Returns `{ status, json: { data: { user, jobApplicationsId } } }`; a new address (no account) answers 401.
 */
export const candidateLogin = async (client, email) => {
  const code = await devCode(client, email).catch((e) => ({ error: e }));
  if (typeof code !== 'string') return { status: 403, json: { code: 'dev_refused' }, text: String(code.error?.message) };
  const v = await client.req('POST', '/api/auth/email/verify', { email, code });
  if (v.status !== 200) return v;
  if (v.json?.data?.status !== 'signed_in') return { status: 401, json: { code: 'no_account' }, text: 'no account', headers: v.headers };
  return v;
};
