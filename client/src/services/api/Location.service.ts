import { RequestEnum } from '../../i18n/General.enums';
import { Routes } from '../../i18n/Routes.enum';
import { Location, LocationsAndDistricts } from '../../models/interfaces/Props.interfaces';
import GlobalApiService from './GlobalApi.service';


export class LocationService {

    private static instance: LocationService;

    static getInstance() {
        if (!this.instance) {
            this.instance = new LocationService();
        }
        return this.instance;
    }

    async fetchAllLocations(): Promise<Location[] | string> {
        const response:
            | string
            | Location[] =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.GET_ALL_LOCATIONS}`,
                [],
            );
        return response;
    }

    async fetchAllLocationsAndDistricts(): Promise<LocationsAndDistricts | string> {
        const response:
            | string
            | LocationsAndDistricts =
            await GlobalApiService.generalRequest(
                RequestEnum.Get,
                `${Routes.GET_ALL_LOCATIONS_AND_DISTRICTS}`,
                [],
            );
        return response;
    }

}