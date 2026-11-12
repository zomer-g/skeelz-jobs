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
