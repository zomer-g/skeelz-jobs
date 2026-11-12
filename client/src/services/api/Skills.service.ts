import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import GlobalApiService from './GlobalApi.service';
import { SkillsApiResponse } from '../../models/interfaces/Api.interfaces';


export class SkillsService {

    private static instance: SkillsService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new SkillsService();
        }
        return this.instance;
    }

  
async fetchSkillsListRequest(): Promise<SkillsApiResponse | string> {
    const response:
        | string
        | SkillsApiResponse =
        await GlobalApiService.generalRequest(
            RequestEnum.Get,
            `${Routes.SKILLS}`,
        );
    return response;
}

}