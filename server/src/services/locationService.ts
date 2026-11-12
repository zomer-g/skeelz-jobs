import * as locationDAL from '../dal/locationDAL.js';
import { JobLocation } from '../models/schemas/locations.js';
export const getAllLocations = async (search?: string): Promise<JobLocation[]> => {
  try {
    return await locationDAL.findAllLocations();
  } catch (error) {
    throw new Error(`Failed to fetch locations: ${error}`);
  }
};

export const getAllLocationsAndDistricts = async (search?: string): Promise<{ locations: { citySymbol: number; city: string }[]; districts: string[] }> => {
  try {
    return await locationDAL.findAllLocationsAndDistricts(search);
  } catch (error) {
    throw new Error(`Failed to fetch locations and districts: ${error}`);
  }
};

export const getLocationByCitySymbol = async (citySymbol: number): Promise<JobLocation> => {
  try {
    const location = await locationDAL.findLocationById(citySymbol);
    if (!location) {
      throw new Error(`Location with citySymbol ${citySymbol} not found`);
    }
    return location;
  } catch (error) {
    throw new Error(`Failed to fetch job location: ${error}`);
  }
};

