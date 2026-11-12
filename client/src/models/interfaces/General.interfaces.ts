import { JobFilterOptionsResponse } from "../types/Job.types";
import { JobData } from "./Props.interfaces";

export interface AssociativeStringArray {
    [key: string]: string
}
export interface InitialData {
    jobList?: { data: JobData[] };
    activeJob?: JobData;
    activeJobIndex?: number;
}

export interface OptionType {
    value: string;
    label: string;
}

export enum JobStatus {
    ACTIVE = 'Active',
    SUSPENDED = 'Suspended',
    CLOSED = 'Closed'
}

export enum ToggleType  {
    TOGGLE_ACTIVE_CLOSED  = 'toggleActiveClosed',
    TOGGLE_SUSPENDED_ACTIVE   = 'toggleSuspendedActive',
}

export enum JobScope {
    FULLTIME = 'FullTime',
    PARTIAL_TIME = 'PartialTime'
}

export interface FilterParamsKeys {
  searchValue: string;
  scope: string;
  city: string;
  district: string;
  skills: string;
}