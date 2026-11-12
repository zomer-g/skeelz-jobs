import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { ApplyPolicy } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';

class SettingsService {
    private static instance: SettingsService;

    public static getInstance() {
        if (!this.instance) {
            this.instance = new SettingsService();
        }
        return this.instance;
    }

    /** Site-wide apply policy defaults (content managers only). */
    async getApplyPolicy(): Promise<ApplyPolicy | string> {
        return GlobalApiService.generalRequest<ApplyPolicy>(RequestEnum.Get, Routes.APPLY_POLICY_SETTINGS, {});
    }

    async updateApplyPolicy(values: Partial<ApplyPolicy>): Promise<ApplyPolicy | string> {
        return GlobalApiService.generalRequest<ApplyPolicy>(RequestEnum.Put, Routes.APPLY_POLICY_SETTINGS, values);
    }
}

export default SettingsService;
