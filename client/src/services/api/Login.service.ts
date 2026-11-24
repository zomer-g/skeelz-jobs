import { RequestEnum } from '../../i18n/General.enums';
import { applyIntentReturnPath } from '../../utils/applyIntent';
import { Routes } from '../../i18n/Routes.enum';
import { OnlyMessageResponse } from '../../models/interfaces/Api.interfaces';
import { LoginResponse } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';
import { environment } from '../../environments/Environment';


export type EmailCodeVerifyResult =
    | ({ status: 'signed_in'; profileIncomplete?: boolean } & LoginResponse)
    | { status: 'signup'; email: string };

export interface SignInProviders {
    /** Always false: candidates have no password (since 11.2026). */
    password: boolean;
    /** "קבלת קוד למייל": a one-time code by email (candidates). */
    emailCode?: boolean;
    /** "Continue with Google" = xhostd SSO (candidates and staff; staff only this way). */
    sso: boolean;
    ssoLogoutUrl: string | null;
    /** "Continue with Microsoft" (candidates only). */
    microsoft?: boolean;
}

export class LoginService {

    private providersPromise: Promise<SignInProviders> | null = null;

    /** Which sign-in buttons to show (asked once per page load; buttons stay hidden if the server can't say). */
    getProviders(): Promise<SignInProviders> {
        if (!this.providersPromise) {
            this.providersPromise = GlobalApiService.generalRequest<SignInProviders>(RequestEnum.Get, `${Routes.AUTH_PROVIDERS}`, {})
                .then((r) => (typeof r === 'string' || !r ? { password: false, emailCode: false, sso: false, ssoLogoutUrl: null, microsoft: false } : r));
        }
        return this.providersPromise;
    }

    /** The signed-in user after "Continue with Google" (a redirect sign-in), or null. */
    async getSession(): Promise<LoginResponse | null | string> {
        return GlobalApiService.generalRequest<LoginResponse | null>(RequestEnum.Get, `${Routes.AUTH_SESSION}`, {});
    }

    /** The pending sign-up after "Continue with Google" with a new identity (email read-only), or null. */
    async getPendingSignup(): Promise<{ email: string; firstName: string; lastName: string } | null | string> {
        return GlobalApiService.generalRequest(RequestEnum.Get, `${Routes.SSO_SIGN_UP}`, {});
    }

    /** Finishes that sign-up: the server takes the email from its own signed cookie, not from here. */
    async completeSsoSignup(values: Record<string, unknown>): Promise<LoginResponse | string> {
        return GlobalApiService.generalRequest<LoginResponse>(RequestEnum.Post, `${Routes.SSO_SIGN_UP}`, values);
    }

    /** Full-page navigation to xhostd SSO (Google); comes back to the current page with ?signin=ok or ?signin_error=… */
    signInUrl(): string {
        const here = this.returnPath();
        return `${environment.API_URL}${Routes.SSO_SIGN_IN}?return_to=${encodeURIComponent(here)}`;
    }

    /** Full-page navigation to "Continue with Microsoft" (candidates only); comes back the same way. */
    microsoftSignInUrl(): string {
        const here = this.returnPath();
        return `${environment.API_URL}${Routes.MS_SIGN_IN}?return_to=${encodeURIComponent(here)}`;
    }

    /** Where a redirect sign-in comes back to: the job being applied to (a same-site /job/<id> path, utils/applyIntent.ts),
     *  else the current page. The server checks it again (security/pure.ts safeReturnPath). */
    private returnPath(): string {
        if (typeof window === 'undefined') return '/';
        return applyIntentReturnPath() ?? window.location.pathname + window.location.search;
    }

    private static instance: LoginService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new LoginService();
        }
        return this.instance;
    }

    /** "קבלת קוד למייל": asks for a sign-in code. The answer is the same for every address (the server never says
     *  whether an account exists). */
    async requestEmailCode(email: string): Promise<{ message: string; resendAfter: number; validMinutes: number } | string> {
        return GlobalApiService.generalRequest(RequestEnum.Post, `${Routes.EMAIL_CODE_REQUEST}`, { email });
    }

    /** Checks the code: signed in (an existing candidate), or a new address → the sign-up form. */
    async verifyEmailCode(email: string, code: string): Promise<EmailCodeVerifyResult | string> {
        return GlobalApiService.generalRequest(RequestEnum.Post, `${Routes.EMAIL_CODE_VERIFY}`, { email, code });
    }

    /** The pending sign-up after a right code for a new address (email read-only), or null. */
    async getPendingEmailSignup(): Promise<{ email: string; firstName: string; lastName: string } | null | string> {
        return GlobalApiService.generalRequest(RequestEnum.Get, `${Routes.EMAIL_SIGN_UP}`, {});
    }

    /** Finishes that sign-up: the server takes the email from its own signed cookie, not from here. */
    async completeEmailSignup(values: Record<string, unknown>): Promise<LoginResponse | string> {
        return GlobalApiService.generalRequest<LoginResponse>(RequestEnum.Post, `${Routes.EMAIL_SIGN_UP}`, values);
    }

    async logoutRequest() {
        const response: OnlyMessageResponse | string =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.LOGOUT}`,
                {},
            );
        return response;
    }

}
