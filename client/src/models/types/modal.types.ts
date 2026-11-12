import { AssociativeStringArray } from "../interfaces/General.interfaces";

// export type JobListResponse = {
//     data: any;
// };

export type modalStyleSetting = {
    titleTypography?: modalTitleTypography,
    titleClass?: string;
    headerClass?: string;
    bodyClass?: string;
    dialogClassName?: string;
    footerClass?: string;
    modalClass?: string;
    closeButtonColor?: string;
}

export type modalTitleTypography = {
    titleClass: string,
    divTitleClass: string,
}

