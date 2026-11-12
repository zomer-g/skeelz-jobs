/* ============================================================================
 *  Who is calling, checked on EVERY request:
 *   1. a valid access token (15 min), or else a refresh token that is still
 *      active in the DB (revoked at logout / password reset / role change);
 *   2. the user is read from the DB, and the role used is the DB role NOW —
 *      a token minted when someone was admin gives nothing once they aren't;
 *   3. a deactivated account is nobody, and access tokens issued before an
 *      admin's "revoke sessions" (users.sessions_revoked_at) are refused.
 *
 *  The gates (separation of duties, see models/enums.ts UserRole):
 *    signedIn            any signed-in account (candidate or staff)
 *    contentManagerOnly  jobs management and candidates' data
 *    adminOnly           security, activity log, staff users — never candidates
 *  authenticateAndAuthorizeWithJWT(roles, tag)  builds a gate
 *  tryExtractTokenPayloadMiddleware             identifies if possible, never refuses
 *
 *  Each gate is tagged (fn.gate) so test/gates.test.mjs can prove that every
 *  route has one, except the routes listed as public there.
 * ========================================================================== */
import { NextFunction, Request, RequestHandler, Response } from "express";
import { TokenType, UserRole } from "../models/enums.js";
import { invalidateTokens } from "../services/tokenStorageService.js";
import { AxiosError } from "axios";
import * as tokenUtilityService from '../services/tokenUtilityService.js';
import * as authService from '../services/authService.js';
import { AuthErrorCodes, AuthErrorMessages } from "../i18n/i18n.js";
import { clearAccessAndRefreshTokensFromCookies, getJWTsFromRequest, setAccessTokenInCookies } from "../utils/authUtils.js";
import { queryOne } from "../config/db.js";
import { isObjectId } from "../utils/ids.js";
import { auditDenied } from "../security/audit.js";
import { issuedBeforeRevoke, methodAllowedForRole } from "../security/pure.js";


type Identity = { id: string; email: string; role: string };
type UserRow = Identity & { deactivated_at: Date | null; sessions_revoked_at: Date | null };

/** The account as it is in the DB now; null when missing or deactivated. */
const loadUser = async (userID: string): Promise<UserRow | null> => {
  if (!isObjectId(userID)) return null;
  const row = await queryOne<UserRow>(
    `SELECT id, email, role, deactivated_at, sessions_revoked_at FROM users WHERE id = $1`, [userID]);
  return row && !row.deactivated_at ? row : null;
};

/** Returns the caller (from the DB), or null. Refreshes the access cookie when it used the refresh token. */
const resolveIdentity = async (req: Request, res: Response): Promise<Identity | null> => {
  const { accessToken, refreshToken } = getJWTsFromRequest(req);
  let userID: string | undefined;
  if (accessToken) {
    let payload: { userID?: string; iat?: number; via?: string } | null = null;
    try {
      payload = tokenUtilityService.verifyAccessToken(accessToken) as { userID?: string; iat?: number; via?: string };
    } catch {
      payload = null; // expired or invalid: try the refresh token
    }
    const user = payload?.userID ? await loadUser(payload.userID) : null;
    // Staff (by the DB role NOW) count only on an xhostd SSO session: a password session of someone who is
    // (or has since become) staff is no session at all (security/pure.ts methodAllowedForRole).
    if (user && !methodAllowedForRole(payload!.via, user.role)) return null;
    if (user && !issuedBeforeRevoke(payload!.iat, user.sessions_revoked_at)) {
      return { id: user.id, email: user.email, role: user.role };
    }
    // Revoked, deactivated or gone: only a live refresh token can still identify.
  }
  let viaRefresh = false;
  let via: string | undefined; // how the session was made (password | xhostd)
  if (!userID && refreshToken) {
    try {
      // Checks the stored (hashed) token: a revoked refresh token is refused here.
      const decoded = await authService.validateRefreshToken(refreshToken);
      userID = decoded?.userID; via = decoded?.via;
      viaRefresh = !!userID;
    } catch {
      userID = undefined;
    }
  }
  if (!userID) return null;
  const user = await loadUser(userID);
  if (!user) return null;
  if (!methodAllowedForRole(via, user.role)) return null;
  if (viaRefresh) {
    setAccessTokenInCookies(res, tokenUtilityService.generateAccessToken({ userID: user.id, userRole: user.role, via }));
  }
  return { id: user.id, email: user.email, role: user.role };
};

const attach = (req: Request, user: Identity) => {
  req.authUser = user;
  req.authJwtPayload = { userID: user.id, userRole: user.role };
};

export type GateTag = 'signedIn' | 'staff' | 'contentManager' | 'admin';

export const authenticateAndAuthorizeWithJWT = (allowedRoles: UserRole[], tag: GateTag): RequestHandler => {
  const gate: RequestHandler & { gate?: string; roles?: readonly UserRole[] } = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await resolveIdentity(req, res);
      if (!user) {
        clearAccessAndRefreshTokensFromCookies(res);
        auditDenied(req, 'not_signed_in');
        throw new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED);
      }
      attach(req, user);
      if (!allowedRoles.includes(user.role as UserRole)) {
        auditDenied(req, `role:${user.role}`);
        // As before: trying a route above your role signs you out.
        await invalidateTokens(user.id, TokenType.REFRESH_TOKEN);
        clearAccessAndRefreshTokensFromCookies(res);
        throw new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorMessages.FORBIDDEN);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
  gate.gate = tag;
  gate.roles = [...allowedRoles];
  return gate;
};

/** Any signed-in account: candidates and staff. */
export const signedIn = authenticateAndAuthorizeWithJWT([UserRole.USER, UserRole.CONTENT_MANAGER, UserRole.ADMIN], 'signedIn');
/** Both staff roles (admin + content manager), for areas they share, e.g. internal API token oversight.
 *  Never for candidates' data itself: that stays contentManagerOnly. */
export const staffOnly = authenticateAndAuthorizeWithJWT([UserRole.ADMIN, UserRole.CONTENT_MANAGER], 'staff');
/** Jobs management and everything that shows candidates (lists, applications, CVs). */
export const contentManagerOnly = authenticateAndAuthorizeWithJWT([UserRole.CONTENT_MANAGER], 'contentManager');
/** System and security: activity log, alerts, grants, access reviews, staff users. Sees no candidates. */
export const adminOnly = authenticateAndAuthorizeWithJWT([UserRole.ADMIN], 'admin');

export const tryExtractTokenPayloadMiddleware: RequestHandler & { gate?: string } = async (req, res, next) => {
  try {
    const user = await resolveIdentity(req, res);
    if (user) attach(req, user);
  } catch {
    // identification is optional here
  }
  next();
};
tryExtractTokenPayloadMiddleware.gate = 'optional';
