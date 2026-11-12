import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { EditUserValues, RegisterFormValues, usersFilter } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';
import { CreateUserResponse, GetUsersResponse, MyProfile } from '../../models/interfaces/Api.interfaces';


export class UserService {

    private static instance: UserService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new UserService();
        }
        return this.instance;
    }

    async createNewUser(values:RegisterFormValues): Promise<any> {
            const response: any  = await GlobalApiService.generalRequest(
                RequestEnum.Post,
                `${Routes.USERS}`,
                values,
            );
            return response;  
    }

    async updateUserById(id: string, values:EditUserValues): Promise<CreateUserResponse | string> {
        const result: CreateUserResponse | string  = await GlobalApiService.generalRequest(
            RequestEnum.Patch,
            `${Routes.USERS}/${id}`,
        values,
        );
        return result;
}

    /** The signed-in candidate's own details (personal area). */
    async getMe(): Promise<MyProfile | string> {
        return GlobalApiService.generalRequest<MyProfile>(RequestEnum.Get, `${Routes.ME}`, {});
    }

    /** Saves the signed-in candidate's own details (the server allows only profile fields, never email/role). */
    async updateMe(values: Record<string, unknown>): Promise<MyProfile | string> {
        return GlobalApiService.generalRequest<MyProfile>(RequestEnum.Patch, `${Routes.ME}`, values);
    }

    /** Removes the CV from the signed-in candidate's own profile. */
    async removeMyCv(): Promise<MyProfile | string> {
        return GlobalApiService.generalRequest<MyProfile>(RequestEnum.Delete, `${Routes.MY_CV}`, {});
    }

async fetchUsersListRequest(usersFilter?: usersFilter): Promise<GetUsersResponse | string> {
    const response:
        | string
        | GetUsersResponse =
        await GlobalApiService.generalRequest(
            RequestEnum.Get,
            `${Routes.USERS}`,
            {usersFilter},
        );
    return response;
}

}