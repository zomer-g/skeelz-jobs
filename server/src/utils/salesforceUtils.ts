import appConfig from "../config/appConfig.js";
import { Guest } from "../models/interfaces/general.interface.js";
import IJobApplication from "../models/schemas/jobApplication.js";
import { Job } from "../models/schemas/jobs.js";
import { JobLocation } from "../models/schemas/locations.js";
import IUser from "../models/schemas/user.js";

export interface SalesforceContact {
    FirstName: string;
    LastName: string;
    Email: string;
    Phone: string;
    Birthdate: string; // Formatted date: 'YYYY-MM-DD'
    AccountId: string,

    dateOfBirth_cambium__c: string;
    email_cambium__c: string;
    firstName_cambium__c: string;
    lastName_cambium__c: string;
    gender_cambium__c: string;
    ID_cambium__c: string;
    citySymbol_cambium__c: string;
    phoneNumber_cambium__c: string;
    skills_cambium__c: string;
    CV_link_cambium__c: string;
}

export interface SalesforceGuestContact {
    LastName: string;
    Email: string;
    Phone: string;
    AccountId: string,

    phoneNumber_cambium__c: string;
    email_cambium__c: string;
    lastName_cambium__c: string;
    ID_cambium__c: string;
}

export interface SalesforceJobsCase {
    AccountId?: string,
    RecordTypeId?: string,


    isSponserd_cambium__c: boolean,
    isMarked_cambium__c: boolean,
    isSelfApply_cambium__c: boolean,
    company_cambium__c: string,
    Position_cambium__c: string,
    PLocation_cambium__c: string,
    citySymbol_cambium__c: string;
    PTime_cambium__c: string,
    PSkills_cambium__c: string,
    PDescription_cambium__c: string,
    PComments_cambium__c?: string,
    PFullName_cambium__c: string,
    PPhone_cambium__c: string,
    PEmail_cambium__c: string,
    PID_cambium__c: string,
    PLink_cambium__c: string,
    PStatus__c: string,
    PCreatedDate_cambium__c?: string,
    PModifiedDate_cambium__c?: string,

}

export interface SalesforceJobApplicationsCase {
    AccountId: string,
    RecordTypeId: string,

    A_ID_cambium__c	?: string, //jobApplicationId for job application case
    A_PID_cambium__c?: string, //jobId for job application
    A_CID_cambium__c?: string, //userId for job application case

}

export const formatUserToSalesforceContact = (user: IUser): SalesforceContact => {
    return {
        FirstName: user.firstName,
        LastName: user.lastName,
        Email: user.email,
        Phone: user.phoneNumber,
        Birthdate: new Date(user.dateOfBirth).toISOString().split('T')[0], // Format to 'YYYY-MM-DD'
        AccountId: appConfig.salesforce.contactsAccountId,

        //custom fields
        dateOfBirth_cambium__c: new Date(user.dateOfBirth).toISOString().split('T')[0],
        email_cambium__c: user.email,
        firstName_cambium__c: user.firstName,
        lastName_cambium__c: user.lastName,
        gender_cambium__c: user.gender,
        ID_cambium__c: user._id.toString(),
        citySymbol_cambium__c: user.citySymbol.toString(),
        phoneNumber_cambium__c: user.phoneNumber,
        skills_cambium__c: user.skills.join(','),
        CV_link_cambium__c: user.cvFileUrl || '',
    };
};

export const formatGuestToSalesforceContact = (guest: Guest): SalesforceGuestContact => {
    return {
        LastName: guest.fullName,
        Email: guest.email,
        AccountId: appConfig.salesforce.contactsAccountId,
        Phone: guest.phoneNumber,

        //custom fields
        email_cambium__c: guest.email,
        lastName_cambium__c: guest.fullName,
        phoneNumber_cambium__c: guest.phoneNumber,
        ID_cambium__c: guest._id.toString() ,
    };
};

export const formatJobToSalesforceJobCase = (job: Job, jobLocation: JobLocation): SalesforceJobsCase => {
    return {
        AccountId: appConfig.salesforce?.jobCaseAccountId,
        RecordTypeId: appConfig.salesforce?.jobCaseRecordTypeId,
        //Custom fields
        isSponserd_cambium__c:job.isSponsored,
        isMarked_cambium__c:job.isMarked,
        isSelfApply_cambium__c:job.isSelfApply,
        company_cambium__c: job.companyName,
        Position_cambium__c: job.title,
        PLocation_cambium__c: jobLocation.city,
        citySymbol_cambium__c: job.citySymbol.toString(),
        PTime_cambium__c: job.jobScope?.join(","),
        PSkills_cambium__c: job.requiredSkills?.join(","),
        PDescription_cambium__c: job.description,
        PComments_cambium__c: job.comments,
        PFullName_cambium__c: job.contactPersonName || "",
        PPhone_cambium__c: job.contactPersonPhone || "",
        PEmail_cambium__c: job.contactPersonEmail || "",
        PID_cambium__c: job._id.toString(),
        PLink_cambium__c: `${appConfig.clientBaseUrl}/job/${job.jobId}`,
        PStatus__c: job.status,
        PCreatedDate_cambium__c: job.createdAt?.toISOString(),
        PModifiedDate_cambium__c: job.updatedAt?.toISOString(),
    };
};


export const formatJobToSalesforceJobApplicationsCase = (jobApplication: IJobApplication): SalesforceJobApplicationsCase => {
    return {
        AccountId: appConfig.salesforce?.jobApplicationsCaseAccountId,
        RecordTypeId: appConfig.salesforce?.jobApplicationsCaseRecordTypeId,

        A_ID_cambium__c: jobApplication._id.toString(), //jobApplicationId for job application case
        A_PID_cambium__c: jobApplication.jobId.toString(), //jobId for job application
        A_CID_cambium__c: jobApplication.userId.toString(),
    };
};


 