export interface JobLocation {
  _id?: string;
  citySymbol: number;
  city: string;
  district: string;
  identifier: number;
  /** WGS84 point of the settlement; null when unknown. */
  lat?: number | null;
  lng?: number | null;
}

export default JobLocation;
