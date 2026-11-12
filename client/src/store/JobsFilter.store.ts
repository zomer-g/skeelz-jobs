import { create } from 'zustand';
import { JobFilterOptionsResponse } from '../models/types/Job.types';
import { JobData } from '../models/interfaces/Props.interfaces';

export type JobsFilterStore = {
    filterLists: JobFilterOptionsResponse;
    selectedLocationFilter: string[];
    selectedSkeelzFilter: string[];
    selectedJobScopeFilter: string[];
    jobList:JobData[];
    /** True until the first list for the current URL is in (never set again by later searches). */
    loading: boolean;
    toggleFilter: () => void;
    initFilterLists: (filterLists: JobFilterOptionsResponse) => void;
    initJobList: (jobList: JobData[]) => void;
};

// The page arrives with the unfiltered active list (window.__INITIAL_DATA__), so the board
// can show it at once. Only a URL that carries search filters must wait for its own results.
const FILTER_PARAMS = ['searchValue', 'scope', 'city', 'district', 'skills'];
const initialList = (): JobData[] | null => {
    if (typeof window === 'undefined') return null;
    const list = window.__INITIAL_DATA__?.jobList?.data;
    return Array.isArray(list) ? (list as JobData[]) : null;
};
export const urlHasJobFilters = (): boolean => {
    if (typeof window === 'undefined') return false;
    const sp = new URLSearchParams(window.location.search);
    return FILTER_PARAMS.some((k) => (sp.get(k) ?? '').trim() !== '');
};
const startList = initialList();
const startsFiltered = urlHasJobFilters();

const useJobsFilterStore = create<JobsFilterStore>((set) => ({
    filterLists: {
        locationList: {},
        skeelzList: {},
        jobScopesList: {},
    },
    selectedLocationFilter: [], 
    selectedSkeelzFilter: [], 
    selectedJobScopeFilter: [],
    jobList: startsFiltered ? [] : (startList ?? []),
    loading: startsFiltered || !startList,
    toggleFilter: () => {
        set((state) => ({
            
        }));
    },
    initFilterLists: (filterLists: JobFilterOptionsResponse) => {
        set(() => ({
            filterLists: filterLists,
        }));
    },
    initJobList: (jobList: JobData[]) => {
        set(() => ({
            jobList: jobList,
            loading: false,
        }));
    },
}));



export default useJobsFilterStore;

export const jobsFilterStore = useJobsFilterStore;