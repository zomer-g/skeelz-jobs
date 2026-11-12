import { NextFunction, Request, Response } from 'express';
import * as locationService from '../services/locationService.js';
import { AxiosError, isAxiosError } from 'axios';
import { LocationsErrorCodes, LocationsErrorMessages } from '../i18n/i18n.js';

export const getAllLocations = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { search } = req.query;

        // Pass the search query to the service layer if provided
        const jobLocations = await locationService.getAllLocations(search as string);
        res.status(200).json({ data: jobLocations });
    } catch (error) {
        if (isAxiosError(error)) {
      return next(error)
          }
            next(new AxiosError(LocationsErrorMessages.FETCH_FAILED, LocationsErrorCodes.FETCH_FAILED));
    }
};

export const getAllLocationsAndDistricts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { search } = req.query;

        // Pass the search query to the service layer if provided
        const jobLocationsAndDistricts = await locationService.getAllLocationsAndDistricts(search as string);
        res.status(200).json({ data: jobLocationsAndDistricts });
    } catch (error) {
        if (isAxiosError(error)) {
      return next(error)
          }
        next(new AxiosError(LocationsErrorMessages.FETCH_FAILED_LOCATION_AND_DISTRICTS, LocationsErrorCodes.FETCH_FAILED_LOCATION_AND_DISTRICTS));
    }
};

export const getLocationByCitySymbol = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const citySymbol = Number(req.params.citySymbol);
        if (isNaN(citySymbol)) {
            res.status(400).json({ message: "Invalid city symbol" });
        }
        const jobLocation = await locationService.getLocationByCitySymbol(citySymbol);
        if (jobLocation) {
            res.status(200).json(jobLocation);
        } else {
            res.status(404).json({ message: 'Job Location not found' });
        }
    } catch (error) {
        if (isAxiosError(error)) {
      return next(error)
          }
        next(new AxiosError(LocationsErrorMessages.JOB_LOCATION_FETCH_FAILED, LocationsErrorCodes.JOB_LOCATION_FETCH_FAILED));
    }
};
