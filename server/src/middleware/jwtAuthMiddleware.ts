/* ============================================================================
 *  Who is calling, checked on EVERY request:
 *   1. a valid access token (15 min), or else a refresh token that is still
 *      active in the DB (revoked at logout / password reset / role change);
 *   2. the user is read from the DB, and the role used is the DB role NOW —
 *      a token minted when someone was admin gives nothing once they aren't;
 *   3. a deactivated account is nobody, and access tokens issued before an
 *      admin's "revoke sessions" (users.sessions_revoked_at) are refused.
 *
 *  Several roles per account (owner, 23.11.2026): a gate opens when ANY of the caller's roles is allowed; staff
 *  roles count only on an xhostd SSO session (security/pure.ts effectiveRoles). Each role keeps its own limits.
 *  The gates (separation of duties, see models/enums.ts UserRole):
 *    signedIn            any signed-in account (candidate or staff)
 *    staffViewers        jobs management (no settings) and viewing candidates: coordinators + content managers + admins
 *    contentManagerOnly  settings, candidates' records, forwards, Salesforce pushes
 *    adminOnly           security, activity log, staff users — never candidates
 *    employerOnly        an employer's own area (/employer/*): own submissions, own jobs, edit requests.
 *                        No other gate admits an employer (signedIn is candidates + staff).
 *  authenticateAndAuthorizeWithJWT(roles, tag)  builds a gate
 *  tryExtractTokenPayloadMiddleware             identifies if possible, never refuses
 *
 *  Each gate is tagged (fn.gate) so test/gates.test.mjs can prove that every
 *  route has one, except the routes listed as public there.
 * ========================================================================== */
import { NextFunction, Request, RequestHandler, Response } from "express";
import { CONTENT_ROLES, TokenType, UserRole, VIEWER_ROLES } from "../models/enums.js";
import { invalidateTokens } from "../services/tokenStorageService.js";
import { AxiosError } from "axios";
import * as tokenUtilityService from '../services/tokenUtilityService.js';
import * as authService from '../services/authService.js';
import { AuthErrorCodes, AuthErrorMessages } from "../i18n/i18n.js";
import { clearAccessAndRefreshTokensFromCookies, getJWTsFromRequest, setAccessTokenInCookies } from "../utils/authUtils.js";
import { queryOne } from "../config/db.js";
import { isObjectId } from "../utils/ids.js";
import { auditDenied } from "../security/audit.js";
import { effectiveRoles, issuedBeforeRevoke } from "../security/pure.js";
import { primaryRole, rolesOf } from "../models/enums.js";


/** role = the highest of `roles`; roles = the account's roles THIS session carries (effectiveRoles). */
type Identity = { id: string; email: string; role: string; roles: string[] };
type UserRow = { id: string; email: string; role: string; roles: string[] | null; deactivated_at: Date | null; sessions_revoked_at: Date | null };

/** The account as it is in the DB now; null when missing or deactivated. */
const loadUser = async (userID: string): Promise<UserRow | null> => {
  if (!isObjectId(userID)) return null;
  const row = await queryOne<UserRow>(
    `SELECT id, email, role, roles, deactivated_at, sessions_revoked_at FROM users WHERE id = $1`, [userID]);
  return row && !row.deactivated_at ? row : null;
};

/** The caller as this session sees them: the DB roles NOW that this sign-in method allows; null when none. */
const identityOf = (user: UserRow, via: string | undefined): Identity | null => {
  const roles = effectiveRoles(rolesOf(user), via);
  return roles.length ? { id: user.id, email: user.email, role: primaryRole(roles), roles } : null;
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
    // Staff roles (by the DB roles NOW) count only on an xhostd SSO session: a candidate who is also staff and
    // signed in another way is a candidate on this session; a staff-only account so signed in is nobody.
    if (user && !issuedBeforeRevoke(payload!.iat, user.sessions_revoked_at)) return identityOf(user, payload!.via);
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
  const who = identityOf(user, via);
  if (!who) return null;
  if (viaRefresh) {
    setAccessTokenInCookies(res, tokenUtilityService.generateAccessToken({ userID: user.id, userRole: who.role, via }));
  }
  return who;
};

const attach = (req: Request, user: Identity) => {
  req.authUser = user;
  req.authJwtPayload = { userID: user.id, userRole: user.role, userRoles: user.roles };
};

export type GateTag = 'signedIn' | 'staff' | 'staffViewer' | 'contentManager' | 'admin' | 'employer' | 'account';

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
      // Any of the session's roles opens the gate (one account may be candidate + employer + staff).
      if (!user.roles.some((r) => allowedRoles.includes(r as UserRole))) {
        auditDenied(req, `role:${user.roles.join('+')}`);
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

/** Any signed-in candidate or staff member. Not employers: an employer's account opens only its own area (employerOnly). */
export const signedIn = authenticateAndAuthorizeWithJWT([UserRole.USER, UserRole.PLACEMENT_COORDINATOR, UserRole.CONTENT_MANAGER, UserRole.ADMIN], 'signedIn');
/** Both staff roles (admin + content manager), for areas they share, e.g. internal API tokens. */
export const staffOnly = authenticateAndAuthorizeWithJWT([UserRole.ADMIN, UserRole.CONTENT_MANAGER], 'staff');
/** Jobs management (create, edit, pin, archive, employer submissions) and VIEWING candidates (lists, applications,
 *  CVs): placement coordinators, content managers and admins (VIEWER_ROLES). A coordinator never sets a threshold
 *  condition or a job's apply settings (refused in the handlers, canManageContent). The hand-overs count everyone. */
export const staffViewers = authenticateAndAuthorizeWithJWT([...VIEWER_ROLES], 'staffViewer');
/** Settings (sign-up fields, apply policy, employer posting), candidates' records, forwards to employers,
 *  Salesforce pushes: content managers AND admins
 *  (CONTENT_ROLES — the one place this is decided). The hand-overs still count and log admins like anyone. */
export const contentManagerOnly = authenticateAndAuthorizeWithJWT([...CONTENT_ROLES], 'contentManager');
/** System and security: activity log, alerts, grants, access reviews, staff users. Admins only. */
export const adminOnly = authenticateAndAuthorizeWithJWT([UserRole.ADMIN], 'admin');
/** An employer's own area: their submissions, their published jobs, edit requests. The employer ROLE only (a
 *  candidate or staff member passes only if they also hold it); every handler reads only rows linked to req.authUser.id. */
export const employerOnly = authenticateAndAuthorizeWithJWT([UserRole.EMPLOYER], 'employer');
/** Any signed-in account, whatever its roles: only for adding a role to oneself (POST /users/me/roles/*). */
export const anyAccount = authenticateAndAuthorizeWithJWT(
  [UserRole.USER, UserRole.EMPLOYER, UserRole.PLACEMENT_COORDINATOR, UserRole.CONTENT_MANAGER, UserRole.ADMIN], 'account');

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
