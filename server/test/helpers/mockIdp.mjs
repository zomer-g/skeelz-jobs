// A mock identity provider for tests: OIDC discovery, JWKS, a token endpoint (authorization code + PKCE),
// and minting of xhostd-style identity cookies. Also serves the Microsoft identity platform paths (e2e-microsoft-sso). Keys are generated per run; nothing here is a real secret.
//
//   const idp = await startMockIdp({ port: 3199 });
//   idp.issuer, idp.jwksUrl
//   idp.registerCode(code, claims)        → the token endpoint answers this code with an ID token of these claims
//   idp.sign(claims, { kid, alg })        → a signed JWT (for xhostd cookies or hand-made bad tokens)
import http from 'node:http';
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export const startMockIdp = async ({ port = 0, host = '127.0.0.1' } = {}) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `test-${crypto.randomBytes(4).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const codes = new Map(); // code -> { claims, challenge?, clientId, clientSecret }
  const seen = { tokenRequests: [] };
  let issuer = '';

  const sign = (claims, { kid: k = kid, alg = 'RS256', key = privateKey } = {}) => {
    const header = b64u(JSON.stringify({ alg, typ: 'JWT', kid: k }));
    const now = Math.floor(Date.now() / 1000);
    const body = b64u(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, ...claims }));
    const input = `${header}.${body}`;
    let sig;
    if (alg === 'RS256') sig = crypto.sign('sha256', Buffer.from(input), key);
    else if (alg === 'HS256') sig = crypto.createHmac('sha256', key).update(input).digest();
    else sig = Buffer.alloc(0);
    return `${input}.${b64u(sig)}`;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    // Also Microsoft's paths (MS_LOGIN_BASE = this mock): /common/discovery/v2.0/keys and /common/oauth2/v2.0/token.
    if (url.pathname === '/jwks' || url.pathname === '/xhost-auth/jwks' || url.pathname === '/common/discovery/v2.0/keys') return json(200, { keys: [jwk] });
    if ((url.pathname === '/token' || url.pathname === '/common/oauth2/v2.0/token') && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const p = new URLSearchParams(raw);
      seen.tokenRequests.push(Object.fromEntries(p));
      const entry = codes.get(p.get('code'));
      if (!entry) return json(400, { error: 'invalid_grant' });
      codes.delete(p.get('code'));
      if (p.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
      if (entry.clientId && (p.get('client_id') !== entry.clientId || p.get('client_secret') !== entry.clientSecret)) {
        return json(401, { error: 'invalid_client' });
      }
      if (entry.challenge) {
        const got = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (got !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
      }
      return json(200, { access_token: 'mock-access', token_type: 'Bearer', expires_in: 3600, id_token: entry.idToken ?? sign(entry.claims) });
    }
    json(404, { error: 'not_found' });
  });
  server.on('connection', (s) => s.unref()); // never keeps a test process alive
  await new Promise((r) => server.listen(port, host, r));
  server.unref();
  issuer = `http://${host}:${server.address().port}`;

  return {
    get issuer() { return issuer; },
    get jwksUrl() { return `${issuer}/jwks`; },
    kid,
    seen,
    sign,
    /** The next token request with this code gets these claims (or a ready-made idToken). */
    registerCode: (code, claims, opts = {}) => codes.set(code, { claims, ...opts }),
    close: () => new Promise((r) => server.close(r)),
  };
};
