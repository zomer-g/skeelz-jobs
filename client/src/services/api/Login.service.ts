import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { OnlyMessageResponse } from '../../models/interfaces/Api.interfaces';
import { LoginFormValues, LoginResponse } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';
import { environment } from '../../environments/Environment';


export interface SignInProviders {
    password: boolean;
    /** "Continue with Google" = xhostd SSO (candidates and staff; staff only this way). */
    sso: boolean;
    ssoLogoutUrl: string | null;
}

export class LoginService {

    private providersPromise: Promise<SignInProviders> | null = null;

    /** Which sign-in buttons to show (asked once per page load; buttons stay hidden if the server can't say). */
    getProviders(): Promise<SignInProviders> {
        if (!this.providersPromise) {
            this.providersPromise = GlobalApiService.generalRequest<SignInProviders>(RequestEnum.Get, `${Routes.AUTH_PROVIDERS}`, {})
                .then((r) => (typeof r === 'string' || !r ? { password: true, sso: false, ssoLogoutUrl: null } : r));
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
        const here = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
        return `${environment.API_URL}${Routes.SSO_SIGN_IN}?return_to=${encodeURIComponent(here)}`;
    }

    private static instance: LoginService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new LoginService();
        }
        return this.instance;
    }

    async login(values: LoginFormValues): Promise<LoginResponse | string> {
        const result: LoginResponse | string = await GlobalApiService.generalRequest(
            RequestEnum.Post,
            `${Routes.LOGIN}`,
            values,
        );
        return result;

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

    async resetPassword(data: { token: string, newPassword: string }): Promise<OnlyMessageResponse | string> {
        const response: OnlyMessageResponse | string =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.RESET_PASSWORD}`,
                data,
            );
        return response;
    }

    async requestPasswordReset(data: { email: string }): Promise<OnlyMessageResponse | string> {
        const response: OnlyMessageResponse | string =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.PASSWORD_RESET_REQUEST}`,
                data,
            );
        return response;
    }

}
