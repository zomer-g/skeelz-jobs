import { Request, Response } from "express";
import { CookieKey, HeaderKeys, TokenKey } from "../models/enums.js";
import appConfig from "../config/appConfig.js";

export const setAccessTokenInCookies = (res: Response, accessToken: string): void => {
    res.cookie(CookieKey.ACCESS_TOKEN, accessToken, {
        httpOnly: true,
        secure: !appConfig.isDevMode,
        sameSite: 'strict',
        maxAge: appConfig.accessTokenLifeSeconds * 1000,
    });
};

export const setRefreshTokenInCookies = (res: Response, refreshToken: string): void => {
    res.cookie(CookieKey.REFRESH_TOKEN, refreshToken, {
        httpOnly: true,
        secure: !appConfig.isDevMode,
        sameSite: 'strict',
        maxAge: appConfig.refreshTokenLifeSeconds * 1000,
    });
};

export const clearAccessAndRefreshTokensFromCookies = (res: Response): void => {
    clearAccessTokenFromCookies(res);
    clearRefreshTokenFromCookies(res);
};

export const clearAccessTokenFromCookies = (res: Response): void => {
    res.clearCookie(CookieKey.ACCESS_TOKEN, {
        httpOnly: true,
        secure: !appConfig.isDevMode,
        sameSite: 'strict',
    });
};

export const clearRefreshTokenFromCookies = (res: Response): void => {
    res.clearCookie(CookieKey.REFRESH_TOKEN, {
        httpOnly: true,
        secure: !appConfig.isDevMode,
        sameSite: 'strict',
    });
};

export const getJWTsFromRequest = (req: Request) => {  //Get Tokens, not get JWTs
    let accessToken: string | undefined = req.cookies[CookieKey.ACCESS_TOKEN];
    let refreshToken: string | undefined = req.cookies[CookieKey.REFRESH_TOKEN];

    // If tokens were not found in the cookies, check the Authorization header
    if (!accessToken || !refreshToken) {
        const authHeader = req.headers[HeaderKeys.AUTHORIZATION];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const tokens = parseAuthorizationHeader(authHeader);
            accessToken = accessToken || tokens.accessToken;
            refreshToken = refreshToken || tokens.refreshToken;
        }
    }
    return { accessToken, refreshToken };
};

export const parseAuthorizationHeader = (authHeader: string | undefined) => {
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const tokenString = authHeader.slice(7); // Remove "Bearer " prefix
        const tokens = tokenString.split(' '); // Split by space to handle multiple tokens

        const result: { accessToken?: string; refreshToken?: string } = {};

        tokens.forEach(token => {
            const [key, value] = token.split(':');
            switch (key) {
                case TokenKey.REFRESH_TOKEN:
                    result['refreshToken'] = value;
                    break;
                case TokenKey.ACCESS_TOKEN:
                    result['accessToken'] = value;
                    break;
                default:
                    // No other tokens to handle
                    break;
            }
        });
        return result;
    }
    return {}; // Return empty object if no valid Bearer token
};
