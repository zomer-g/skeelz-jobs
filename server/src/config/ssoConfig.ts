/* ============================================================================
 *  Sign-in with Google = xhostd SSO (candidates and staff). OFF unless
 *  SSO_ENABLED=true. Nothing to register anywhere: xhostd serves
 *  /xhost-auth/* on every channel (its own Google client) and signs an identity
 *  cookie (RS256, JWKS at auth.xhostd.com).
 *
 *  The issuer / JWKS / login-URL overrides exist for local tests against a mock
 *  provider and are honoured ONLY with DEV_MODE=true (production always uses the
 *  real xhostd endpoints).
 * ========================================================================== */
export const XHOSTD_ISSUER = 'https://auth.xhostd.com';

const dev = () => process.env.DEV_MODE === 'true';
const devOverride = (key: string): string | undefined => (dev() && process.env[key] ? process.env[key] : undefined);

export const xhostdConfig = () => {
  const issuer = devOverride('SSO_ISSUER') ?? XHOSTD_ISSUER;
  return {
    enabled: process.env.SSO_ENABLED === 'true',
    issuer,
    jwksUrl: devOverride('SSO_JWKS_URL') ?? `${issuer}/xhost-auth/jwks`,
    loginUrl: devOverride('SSO_LOGIN_URL') ?? '/xhost-auth/login',
    logoutUrl: devOverride('SSO_LOGOUT_URL') ?? '/xhost-auth/logout',
    cookieName: '__Host-xhost_id',
  };
};

/* ============================================================================
 *  "Continue with Microsoft" (candidates only): our own OIDC client at the
 *  Microsoft identity platform v2, `common` authority (personal Microsoft
 *  accounts AND work/school accounts). OFF unless ENABLE_MICROSOFT_SSO=true and
 *  both MS_CLIENT_ID (env) and MS_CLIENT_SECRET (secret) are set. Setup for the
 *  owner: docs/microsoft-sso.md. Flow and email rule: security/microsoft.ts.
 *
 *  MS_LOGIN_BASE (a local mock, test/e2e-microsoft-sso.mjs) is honoured ONLY
 *  with DEV_MODE=true; production always talks to login.microsoftonline.com.
 *  MS_REDIRECT_URI pins the callback URL; without it the URL is built from the
 *  host the request came in on (Microsoft refuses any URI not registered).
 * ========================================================================== */
export const MICROSOFT_LOGIN_BASE = 'https://login.microsoftonline.com';

export const microsoftConfig = () => {
  const base = (devOverride('MS_LOGIN_BASE') ?? MICROSOFT_LOGIN_BASE).replace(/\/$/, '');
  const clientId = String(process.env.MS_CLIENT_ID ?? '').trim();
  const clientSecret = String(process.env.MS_CLIENT_SECRET ?? '');
  return {
    enabled: process.env.ENABLE_MICROSOFT_SSO === 'true' && !!clientId && !!clientSecret,
    clientId,
    clientSecret,
    loginBase: base,
    authorizeUrl: `${base}/common/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/common/oauth2/v2.0/token`,
    jwksUrl: `${base}/common/discovery/v2.0/keys`,
    redirectUri: String(process.env.MS_REDIRECT_URI ?? '').trim(),
    scope: 'openid email profile',
  };
};
