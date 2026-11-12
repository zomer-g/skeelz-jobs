import { AxiosResponse } from 'axios';
import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { MyCvResponse, OnlyMessageResponse } from '../../models/interfaces/Api.interfaces';
import GlobalApiService from './GlobalApi.service';

export class UploadFileService {

    private static instance: UploadFileService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new UploadFileService();
        }
        return this.instance;
    }

    async uploadCV(token: string,formData:FormData, headers: Record<string, string>): Promise<OnlyMessageResponse  | string> {
        const response:
            | string
            | OnlyMessageResponse  =
            await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.UPLOAD_CV}/${token}`,
                formData,
                headers,
            );
        return response;
    }

    async fetchCV(userId: string): Promise< AxiosResponse<Blob> | string> {
        const customHeaders = {};
        const response:
            |  AxiosResponse<Blob>
            | string =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.FETCH_CV}/${userId}`,
                {},
                customHeaders,
                {
                    responseType: 'blob',
                    returnWholeResponse: true
                });
        return response;
    }

    /** Name and upload date of the signed-in candidate's own profile CV. */
    async fetchMyCvInfo(): Promise<MyCvResponse | string> {
        return GlobalApiService.generalRequest(RequestEnum.Get, Routes.MY_CV, {});
    }

    /** The signed-in candidate's own profile CV file. */
    async fetchMyCvFile(): Promise<AxiosResponse<Blob> | string> {
        return GlobalApiService.generalRequest(RequestEnum.Get, Routes.MY_CV_FILE, {}, {}, {
            responseType: 'blob',
            returnWholeResponse: true,
        });
    }

    async deleteCV(cvFileUrl: string, userId?: string): Promise<string> {
        const response:
            string =
            await GlobalApiService.generalRequest(
                RequestEnum.Delete,
                `${Routes.DELETE_CV}`,
                {cvFileUrl, userId},
            );
        return response;
    }
}