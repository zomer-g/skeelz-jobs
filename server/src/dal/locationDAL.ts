import { escapeLike, query, queryOne } from "../config/db.js";
import { JobLocation } from "../models/schemas/locations.js";

const SELECT = `city_symbol AS "citySymbol", city, district, identifier`;

export const findAllLocations = async (): Promise<JobLocation[]> => {
  // lat/lng feed the map search's town picker.
  return query<JobLocation>(`SELECT city_symbol::text AS "_id", ${SELECT}, lat, lng FROM locations ORDER BY identifier, city_symbol`);
};

export const findAllLocationsAndDistricts = async (
  search: string | undefined
): Promise<{ locations: { citySymbol: number; city: string }[]; districts: string[] }> => {
  const params: any[] = [];
  let where = '';
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    where = `WHERE city ILIKE $1 OR district ILIKE $1`;
  }
  const rows = await query<{ citySymbol: number; city: string; district: string }>(
    `SELECT ${SELECT} FROM locations ${where} ORDER BY identifier, city_symbol`, params
  );
  const locations = rows.map((r) => ({ citySymbol: r.citySymbol, city: r.city }));
  const districts = Array.from(new Set(rows.map((r) => r.district).filter((d) => d !== null && d !== undefined)));
  return { locations, districts };
};

export const findLocationById = async (citySymbol: number): Promise<JobLocation | null> => {
  return queryOne<JobLocation>(`SELECT city_symbol::text AS "_id", ${SELECT} FROM locations WHERE city_symbol = $1`, [citySymbol]);
};
