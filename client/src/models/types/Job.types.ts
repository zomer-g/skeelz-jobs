import { AssociativeStringArray } from "../interfaces/General.interfaces";

export type JobListResponse = {
    data: any;
};

export type JobFilterOptionsResponse = {
    locationList: AssociativeStringArray;
    skeelzList: AssociativeStringArray;
    jobScopesList: AssociativeStringArray;
}
