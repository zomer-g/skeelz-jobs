import axios, { AxiosHeaders, RawAxiosRequestHeaders,AxiosResponse, ResponseType } from 'axios';
import { AxiosInstance, AxiosError } from 'axios';
import rateLimit from 'axios-rate-limit';
import { environment } from '../../environments/Environment';
import { RequestEnum, ResponseEnum } from '../../i18n/General.enums';
import * as ApiInterfaces from '../../models/interfaces/Api.interfaces';
import { i18n } from '../../i18n/I18n';
import { ErrorManager } from '../errors/ErrorsManager.service';
import useAuthStore from '../../store/Auth.store';
import { setLastApiErrorCode } from '../../utils/lastApiError';

const MAX_REQUESTS = 2;
const MAX_RPS = 2;
const PER_MILLISECONDS = 500;

class ApiService {
    private axiosClient: AxiosInstance;
    private translations = i18n.getTranslations();
    private logOut = useAuthStore.getState().logOut;
    static instance: ApiService;

    constructor() {
        // The ApiClient wraps calls to the underlying Axios client.
        this.axiosClient = rateLimit(
            axios.create({
                timeout: environment.REQUEST_TIMEOUT,
                withCredentials: true,
            }),
            {
                maxRequests: MAX_REQUESTS,
                perMilliseconds: PER_MILLISECONDS,
                maxRPS: MAX_RPS,
            },
        );
    }

    //Api service singleton
    static getInstance() {
        if (!this.instance) {
            this.instance = new ApiService();
        }
        return this.instance;
    }

    // All odd responses will result in a null
    checkUndefinedREsponse = (response: any) => {
        if (
            response &&
            typeof response.data !== ResponseEnum.Undefined
        ) {
            return response.data;
        }
        return null;
    };

    // ---
    // PUBLIC METHODS.
    // ---

    public async generalRequest<T>(
        method: string,
        route: string,
        data: ApiInterfaces.Data,
        customHeaders: RawAxiosRequestHeaders = {},
        additionalOptions: {
            responseType?: ResponseType,
            returnWholeResponse?: boolean;
            retryCount?: number;
        } = {},

    ): Promise<T | string> {
        setLastApiErrorCode(null);
        try {
            switch (method) {
                case RequestEnum.Get:
                    {
                        const response = await this.get<any>({
                            url: route,
                            params: data || {},
                            customHeaders,
                            additionalOptions: additionalOptions
                        });
                        if (

                            response &&
                            typeof response.data !==
                            ResponseEnum.Undefined
                        ) {
                            if (additionalOptions?.returnWholeResponse) {
                                return response;
                            }
                            return response.data;
                        }
                    }
                    break;
                case RequestEnum.Post:
                    if (data) {
                        const response = await this.post<any>({
                            url: route,
                            data,
                            customHeaders,
                        });
                        if (
                            response &&
                            typeof response.data !==
                                ResponseEnum.Undefined
                        ) {
                            return response.data;
                        }
                    }
                    break;
                case RequestEnum.Put:
                    if (data) {
                        const response = await this.put<any>({
                            url: route,
                            data,
                        });
                        if (
                            response &&
                            typeof response.data !==
                                ResponseEnum.Undefined
                        ) {
                            return response.data;
                        }
                    }
                    break;
                case RequestEnum.Patch:
                    if (data) {
                        const response = await this.patch<any>({
                            url: route,
                            data,
                        });
                        if (
                            response &&
                            typeof response.data !==
                            ResponseEnum.Undefined
                        ) {
                            return response.data;
                        }
                    }
                    break;
                case RequestEnum.Delete:
                    if (data) {
                        const response = await this.delete<any>({
                            url: route,
                            data,
                        });
                        if (
                            response &&
                            typeof response.data !==
                                ResponseEnum.Undefined
                        ) {
                            return response.data;
                        }
                    }
                    break;
            }
            return Promise.reject(RequestEnum.ErrorBadRequest);
        } catch (error: any) {
            // A file request (responseType blob) carries its JSON error as a Blob.
            if (typeof Blob !== 'undefined' && error instanceof Blob) {
                try { error = JSON.parse(await error.text()); } catch { /* keep as is */ }
            }
            setLastApiErrorCode(error?.code ?? (error === RequestEnum.ErrorBadRequest ? null : 'network'));
            // Security refusals (daily limit, activity log unavailable, cross-site) and the threshold-condition refusal carry their own Hebrew message.
            if (error && typeof error.code === 'string' && /^(limit_|audit_unavailable|cross_site|threshold_not_confirmed|candidate_read_only|job_on_existing_site)/.test(error.code) && error.message) {
                return error.message;
            }
            this._interceptor(error);
            let errorContext: string = this.translations.GlobalErrors.GENERAL_ERROR;
            if (error && error.code) {
                errorContext = this.handleErrorCode(error.code);
            }
            if (!error.code) {
                return error;
            }
            console.error(
                RequestEnum.ErrorOnReq +
                    route +
                    RequestEnum.ErrorConcat +
                    errorContext,
            );
            return errorContext;
        }
    }

    public async get<T>(options: ApiInterfaces.GetOptions): Promise<T | AxiosResponse<T>> {
        try {
            const axiosResponse = await this.axiosClient.request<T>({
                method: RequestEnum.Get,
                url: `${environment.API_URL}${options.url}`,
                params: options.params,
                headers: this.getHeaders(options.customHeaders),
                responseType: options.additionalOptions?.responseType
            });
            return options.additionalOptions?.returnWholeResponse ? axiosResponse : axiosResponse.data;
        } catch (error) {
            return Promise.reject(this.normalizeError(error));
        }
    }

    public async post<T>(options: ApiInterfaces.PostOptions): Promise<T> {
        try {
            const axiosResponse = await this.axiosClient.request<T>({
                method: RequestEnum.Post,
                url: `${environment.API_URL}${options.url}`,
                data: options.data,
                headers: this.getHeaders(options.customHeaders),
            });
            return axiosResponse.data;
        } catch (error) {
            return Promise.reject(this.normalizeError(error));
        }
    }

    public async put<T>(options: ApiInterfaces.PostOptions): Promise<T> {
        try {
            const axiosResponse = await this.axiosClient.request<T>({
                method: RequestEnum.Put,
                url: `${environment.API_URL}${options.url}`,
                data: options.data,
                headers: this.getHeaders(),
            });
            return axiosResponse.data;
        } catch (error) {
            return Promise.reject(this.normalizeError(error));
        }
    }

    public async patch<T>(options: ApiInterfaces.PostOptions): Promise<T> {
        try {
            const axiosResponse = await this.axiosClient.request<T>({
                method: RequestEnum.Patch,
                url: `${environment.API_URL}${options.url}`,
                data: options.data,
                headers: this.getHeaders(),
            });
            return axiosResponse.data;
        } catch (error) {
            return Promise.reject(this.normalizeError(error));
        }
    }

    public async delete<T>(options: ApiInterfaces.PostOptions): Promise<T> {
        try {
            const axiosResponse = await this.axiosClient.request<T>({
                method: RequestEnum.Delete,
                url: `${environment.API_URL}${options.url}`,
                data: options.data,
                headers: this.getHeaders(),
            });
            return axiosResponse.data;
        } catch (error) {
            return Promise.reject(this.normalizeError(error));
        }
    }

    // ---
    // PRIVATE METHODS.
    // ---

    private _interceptor(error?: any) {
        if (
            error === ResponseEnum.Unauthorized ||
            error.message === ResponseEnum.Unauthorized ||
            error.message === ResponseEnum.Forbidden
        ) {
            this.logOut();
        }
    }

    /* Errors can occur for a variety of reasons.
     * We will normalize the error response so that
     * the calling context can assume a standard error structure.
     */
    private normalizeError(error: any): ApiInterfaces.ErrorResponse {
        const err = error as AxiosError;
        if (err.response && err.response.data) {
            return err.response.data as ApiInterfaces.ErrorResponse;
        }
        return {
            code: ResponseEnum.UnknownError,
            message: ResponseEnum.UnknownErrorMessage,
        };
    }

    // Required for authorization
    private getHeaders(customHeaders: RawAxiosRequestHeaders = {}): AxiosHeaders {
        const idToken = ''; // TODO: get that from local storage
        const authorizationHeader = idToken ? { Authorization: `Bearer ${idToken}` } : {};
        return new AxiosHeaders({ ...authorizationHeader, ...customHeaders });
    }


    //error code must begin with 2 chars followed by a number, chars will indicate the related page/feature.
    handleErrorCode(code: string): string {
        if (code.length < 3) {
            return this.translations.GlobalErrors.GENERAL_ERROR;
        }
        const location = code.substring(0, 2).toLowerCase();
        const strNumber = code.substring(2);
        const allowedChars = /^[a-z]+$/;
        const allowedNumbers = /^\d+$/;
        if (!allowedChars.test(location) || !allowedNumbers.test(strNumber)) {
            return this.translations.GlobalErrors.GENERAL_ERROR;
        }
        const codeNumber = Number(strNumber);
        return ErrorManager(location, codeNumber);
    }
}

export default ApiService.getInstance();
