import axios, { AxiosError } from 'axios';
import { getSalesforceConfig } from '../config/salesforceConfig.js';
import appConfig from '../config/appConfig.js';
import IUser from '../models/schemas/user.js';
import { logAxiosError, streamToBuffer } from '../utils/utils.js';
import { formatJobToSalesforceJobCase, formatUserToSalesforceContact, SalesforceJobsCase, SalesforceContact, formatJobToSalesforceJobApplicationsCase, SalesforceJobApplicationsCase, formatGuestToSalesforceContact, SalesforceGuestContact } from '../utils/salesforceUtils.js';
import { Job } from '../models/schemas/jobs.js';
import { JobLocation } from '../models/schemas/locations.js';
import IJobApplication from '../models/schemas/jobApplication.js';
import { getFileFromS3 } from './s3Service.js';
import { Files } from '../models/enums.js';
import { SalesforceErrorCodes, SalesforceErrorMessages } from '../i18n/i18n.js';
import { Guest } from '../models/interfaces/general.interface.js';

const API_VERSION = appConfig.salesforce.apiVersion;

// Ids go into SOQL strings; only our own 24-hex / Salesforce ids are allowed.
const soqlId = (id: unknown): string => {
  const s = String(id ?? '');
  if (!/^[A-Za-z0-9]{15,24}$/.test(s)) throw new Error('invalid id for SOQL');
  return s;
};

// Function to create a contact in Salesforce
export const createContact = async (user: IUser): Promise<void> => {
    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return;
    }

    try {
        const auth = await getSalesforceConfig();
        const contactData: SalesforceContact = formatUserToSalesforceContact(user);

        const url = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Contact/`;
        const response = await axios.post(url, contactData, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        console.log('Contact Created Successfully:', response.data);
    } catch (error: unknown) {
        logAxiosError(error, 'Failed to create contact in Salesforce');
        throw new AxiosError(SalesforceErrorMessages.FAILED_TO_CREATE_CONTACT, SalesforceErrorCodes.FAILED_TO_CREATE_CONTACT);
        
    }
};

export const createContactAsGuest = async (guest: Guest): Promise<void> => {
    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return;
    }

    try {
        const auth = await getSalesforceConfig();
        const contactData: SalesforceGuestContact = formatGuestToSalesforceContact(guest);

        const url = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Contact/`;
        const response = await axios.post(url, contactData, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        console.log('Contact Created Successfully:', response.data);
    } catch (error: unknown) {
        logAxiosError(error, 'Failed to create contact in Salesforce');
        throw new AxiosError(SalesforceErrorMessages.FAILED_TO_CREATE_CONTACT, SalesforceErrorCodes.FAILED_TO_CREATE_CONTACT);
        
    }
};

export const updateContact = async (
    updateData: IUser,
    userId: string
): Promise<void> => {

    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return;
    }

    try {
        const auth = await getSalesforceConfig();

        const queryUrl = `${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(
            `SELECT Id FROM Contact WHERE ID_cambium__c = '${soqlId(userId)}'`
        )}`;
        const queryResponse = await axios.get(queryUrl, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        const records = queryResponse.data.records;
        if (!records || records.length === 0) {
            console.warn(`No Salesforce contact found with ID: ${userId}`);
            return;
        }

        const salesforceId = records[0].Id;
        const contactData: SalesforceContact = formatUserToSalesforceContact(updateData);
        const updateUrl = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Contact/${salesforceId}`;
        await axios.patch(updateUrl, contactData, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        console.log(`Salesforce contact with Id ${salesforceId} updated successfully.`);
    } catch (error: unknown) {
        logAxiosError(error, `Failed to update Salesforce contact for ID: ${userId}`);
        throw new AxiosError(SalesforceErrorMessages.FAILED_TO_UPDATE_CONTACT, SalesforceErrorCodes.FAILED_TO_UPDATE_CONTACT);
    
      }
};

// Function to create a job (Case) in Salesforce
export const createJobCase = async (job: Job, jobLocation: JobLocation): Promise<void> => {
    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return;
    }

    try {
        const auth = await getSalesforceConfig();
        const caseData: SalesforceJobsCase = formatJobToSalesforceJobCase(job, jobLocation);

        const url = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Case/`;
        const response = await axios.post(url, caseData, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        console.log('Case Created Successfully:', response.data);
    } catch (error: unknown) {
        logAxiosError(error, 'Failed to create Case in Salesforce');
        throw new AxiosError(SalesforceErrorMessages.FAILED_TO_CREATE_CASE, SalesforceErrorCodes.FAILED_TO_CREATE_CASE);

    }
};

export const updateJobCase = async (job: Job, jobLocation: JobLocation): Promise<void> => {
  if (!appConfig.salesforce.enableSalesforce) {
      console.log('Salesforce operations are disabled in this environment.');
      return;
  }

  try {
      const auth = await getSalesforceConfig();
      const query = `SELECT Id FROM Case WHERE PID_cambium__c = '${soqlId(job._id)}' LIMIT 1`;
      const queryUrl = `${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(query)}`;
      const result = await axios.get(queryUrl, {
          headers: {
              Authorization: `Bearer ${auth.access_token}`,
          },
      });

      const records = result.data.records;
      if (!records || records.length === 0) {
          throw new Error(`No Case found with PID_cambium__c = ${job._id}`);
      }
      
      const caseId = records[0].Id;
      const updatedFields = formatJobToSalesforceJobCase(job, jobLocation);
      delete updatedFields.AccountId;
      delete updatedFields.RecordTypeId;

      const patchUrl = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Case/${caseId}`;
      await axios.patch(patchUrl, updatedFields, {
          headers: {
              Authorization: `Bearer ${auth.access_token}`,
              'Content-Type': 'application/json',
          },
      });

      console.log(`Case ${caseId} updated successfully.`);

  } catch (error: any) {
      logAxiosError(error, 'Failed to update Case in Salesforce');
      throw new Error('Salesforce update failed.');
  }
};


/** Creates the application Case and returns its Salesforce Id. */
export const createJobApplicationCase = async (jobApplication: IJobApplication): Promise<string | undefined> => {
    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return undefined;
    }

    try {
        const auth = await getSalesforceConfig();
        const caseData: SalesforceJobApplicationsCase = formatJobToSalesforceJobApplicationsCase(jobApplication);

        const url = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/Case/`;
        const response = await axios.post(url, caseData, {
            headers: {
                Authorization: `Bearer ${auth.access_token}`,
                'Content-Type': 'application/json',
            },
        });

        console.log('Case Created Successfully:', response.data);
        return response.data?.id ? String(response.data.id) : undefined;
    } catch (error: unknown) {
        logAxiosError(error, 'Failed to create Case in Salesforce');
        throw new AxiosError(SalesforceErrorMessages.FAILED_TO_CREATE_CASE, SalesforceErrorCodes.FAILED_TO_CREATE_CASE);

    }
};

/**
 * Uploads the CV used for one application and links it to that application's
 * Case, so the Case carries the CV the candidate chose (a job-only CV, or the
 * profile CV as it was when they applied), whatever the Contact holds later.
 */
export const attachCvToApplicationCase = async (s3FileKey: string, caseId: string, jobApplicationId: string): Promise<void> => {
    if (!appConfig.salesforce.enableSalesforce) return;
    const auth = await getSalesforceConfig();
    const headers = { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' };
    const fileBuffer = await streamToBuffer(await getFileFromS3(s3FileKey));
    const fileName = s3FileKey.split('/').pop() || Files.CV_DEFAULT_NAME;

    const versionRes = await axios.post(
        `${auth.instance_url}/services/data/${API_VERSION}/sobjects/ContentVersion`,
        {
            Title: fileName,
            PathOnClient: fileName,
            VersionData: fileBuffer.toString('base64'),
            Description: `jobApplicationId:${jobApplicationId}`,
        },
        { headers }
    );
    const contentVersionId = versionRes.data?.id;
    if (!contentVersionId) throw new AxiosError(SalesforceErrorMessages.FAILED_TO_GET_CONTENT_VERSION_ID, SalesforceErrorCodes.FAILED_TO_GET_CONTENT_VERSION_ID);

    const queryRes = await axios.get(`${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(
        `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${soqlId(contentVersionId)}'`
    )}`, { headers });
    const contentDocumentId = queryRes?.data?.records?.[0]?.ContentDocumentId;
    if (!contentDocumentId) throw new AxiosError(SalesforceErrorMessages.CONTENT_DOCUMENT_ID_NOT_FOUND, SalesforceErrorCodes.CONTENT_DOCUMENT_ID_NOT_FOUND);

    await axios.post(
        `${auth.instance_url}/services/data/${API_VERSION}/sobjects/ContentDocumentLink`,
        { ContentDocumentId: contentDocumentId, LinkedEntityId: soqlId(caseId), ShareType: 'V', Visibility: 'AllUsers' },
        { headers }
    );
    console.log('CV attached to the job application Case at Salesforce');
};

export const uploadCVFromS3ToSalesforce = async (
    s3FileKey: string,
    userId: string
  ): Promise<void> => {

    if (!appConfig.salesforce.enableSalesforce) {
        console.log('Salesforce operations are disabled in this environment.');
        return;
    }
    
    try {
      const auth = await getSalesforceConfig();
      const fileStream = await getFileFromS3(s3FileKey);
      const fileBuffer = await streamToBuffer(fileStream);
      const base64File = fileBuffer.toString('base64');
      const fileName = s3FileKey.split('/').pop() || Files.CV_DEFAULT_NAME;
  
      const contentVersionPayload = {
        Title: fileName,
        PathOnClient: fileName,
        VersionData: base64File,
        Description: `userId:${userId}`,
      };
  
      const contentVersionRes = await axios.post(
        `${auth.instance_url}/services/data/${API_VERSION}/sobjects/ContentVersion`,
        contentVersionPayload,
        {
          headers: {
            Authorization: `Bearer ${auth.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );
  
      const contentVersionId = contentVersionRes.data?.id;
      if (!contentVersionId) throw new AxiosError(SalesforceErrorMessages.FAILED_TO_GET_CONTENT_VERSION_ID, SalesforceErrorCodes.FAILED_TO_GET_CONTENT_VERSION_ID);
      ;
  
      const contentVersionQueryUrl =  `${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(
        `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${soqlId(contentVersionId)}'`
      )}`;

      const queryRes = await axios.get(contentVersionQueryUrl,{
          headers: {
            Authorization: `Bearer ${auth.access_token}`,
          },
        }
      );
  
      const contentDocumentId = queryRes?.data?.records?.[0]?.ContentDocumentId;
      if (!contentDocumentId) {
        throw new AxiosError(SalesforceErrorMessages.CONTENT_DOCUMENT_ID_NOT_FOUND, SalesforceErrorCodes.CONTENT_DOCUMENT_ID_NOT_FOUND);

      }
  
      //Fetch Contact by user id
      const contactQueryUrl =  `${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(
        `SELECT Id FROM Contact WHERE ID_cambium__c = '${soqlId(userId)}'`
      )}`;

      const contactRes = await axios.get(contactQueryUrl,
        {
          headers: {
            Authorization: `Bearer ${auth.access_token}`,
          },
        }
      );
  
      const contactId = contactRes.data.records?.[0]?.Id;
      if (!contactId) throw new AxiosError(SalesforceErrorMessages.CONTACT_NOT_FOUND, SalesforceErrorCodes.CONTACT_NOT_FOUND);
      ;
  
      //Link file to Contact
      try {
        await axios.post(
          `${auth.instance_url}/services/data/${API_VERSION}/sobjects/ContentDocumentLink`,
          {
            ContentDocumentId: contentDocumentId,
            LinkedEntityId: contactId,
            ShareType: 'V', // Viewer
            Visibility: 'AllUsers',
          },
          {
            headers: {
              Authorization: `Bearer ${auth.access_token}`,
              'Content-Type': 'application/json',
            },
          }
        );

      } catch (err: any) {
        if (err?.response?.data?.[0]?.errorCode === 'DUPLICATE_VALUE') {
          console.log('File already linked to Contact.');
        } else {
          console.error('Failed to link to Contact:', err.response?.data || err.message);
          throw err;
        }
      }
      console.log(`CV uploaded and linked to Contact at Salesforce`);
    } catch (error: any) {
      console.error('Upload failed:', error?.response?.data || error.message);
      throw new AxiosError(SalesforceErrorMessages.FAILED_TO_CREATE_CONTACT, SalesforceErrorCodes.FAILED_TO_CREATE_CONTACT);
    }
  };

/* ----------------------------------------------------------------------------
 *  Idempotent pushes for the internal API (internalApi/salesforcePush.ts).
 *  Each one finds the record by its id field in Salesforce (or uses the Id we
 *  stored last time), updates it if it exists, creates it if not, and returns
 *  the Salesforce Id. They never log response bodies; callers store only a code.
 *  Callers check ENABLE_SALESFORCE first; these refuse too, without calling out.
 * -------------------------------------------------------------------------- */
const assertEnabled = () => {
    if (!appConfig.salesforce.enableSalesforce) throw new Error('Salesforce is disabled');
};
const sfHeaders = (auth: { access_token: string }) => ({ Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' });

const findId = async (auth: { access_token: string; instance_url: string }, object: 'Case' | 'Contact', field: string, value: string) => {
    const q = `SELECT Id FROM ${object} WHERE ${field} = '${soqlId(value)}' LIMIT 1`;
    const r = await axios.get(`${auth.instance_url}/services/data/${API_VERSION}/query?q=${encodeURIComponent(q)}`, { headers: sfHeaders(auth) });
    const id = r.data?.records?.[0]?.Id;
    return id ? String(id) : undefined;
};

const patchOrCreate = async (
    auth: { access_token: string; instance_url: string },
    object: 'Case' | 'Contact', existingId: string | undefined, updateBody: object, createBody: object
): Promise<{ id: string; created: boolean }> => {
    const base = `${auth.instance_url}/services/data/${API_VERSION}/sobjects/${object}`;
    if (existingId) {
        try {
            await axios.patch(`${base}/${soqlId(existingId)}`, updateBody, { headers: sfHeaders(auth) });
            return { id: existingId, created: false };
        } catch (e: any) {
            if (e?.response?.status !== 404) throw e; // deleted in Salesforce: create it again below
        }
    }
    const r = await axios.post(`${base}/`, createBody, { headers: sfHeaders(auth) });
    if (!r.data?.id) throw new Error('Salesforce returned no id');
    return { id: String(r.data.id), created: true };
};

/** Job Case (PID_cambium__c = job id). */
export const upsertJobCase = async (job: Job, jobLocation: JobLocation, knownId?: string) => {
    assertEnabled();
    const auth = await getSalesforceConfig();
    const id = knownId || await findId(auth, 'Case', 'PID_cambium__c', String(job._id));
    const create = formatJobToSalesforceJobCase(job, jobLocation);
    const update = { ...create };
    delete update.AccountId;
    delete update.RecordTypeId;
    return patchOrCreate(auth, 'Case', id, update, create);
};

/** Candidate Contact (ID_cambium__c = user id). */
export const upsertContact = async (user: IUser, knownId?: string) => {
    assertEnabled();
    const auth = await getSalesforceConfig();
    const id = knownId || await findId(auth, 'Contact', 'ID_cambium__c', String(user._id));
    const body = formatUserToSalesforceContact(user);
    return patchOrCreate(auth, 'Contact', id, body, body);
};

/** Application Case (A_ID_cambium__c = application id). Never re-created once it exists. */
export const ensureApplicationCase = async (jobApplication: IJobApplication, knownId?: string) => {
    assertEnabled();
    const auth = await getSalesforceConfig();
    const id = knownId || await findId(auth, 'Case', 'A_ID_cambium__c', String(jobApplication._id));
    if (id) return { id, created: false };
    const r = await axios.post(`${auth.instance_url}/services/data/${API_VERSION}/sobjects/Case/`,
        formatJobToSalesforceJobApplicationsCase(jobApplication), { headers: sfHeaders(auth) });
    if (!r.data?.id) throw new Error('Salesforce returned no id');
    return { id: String(r.data.id), created: true };
};
