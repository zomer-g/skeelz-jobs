/* ============================================================================
 *  What this site writes into Salesforce: field by field (docs/salesforce.md has
 *  the same table for the owner). Pure: no DB, no network; unit-tested.
 *
 *  The *_cambium__c fields are the ones the existing site's integration already
 *  uses in the org (Contact, and Case with two record types). Nothing here is new
 *  data compared with that integration: candidates' Contact, the application Case
 *  (linking job and candidate) with the CV, job Cases for jobs created HERE (never
 *  for jobs imported from the existing site), and employers' Contacts.
 * ========================================================================== */
import { asCustomValues, CustomFieldDef, SF_TYPES } from '../models/schemas/customFields.js';
import appConfig from "../config/appConfig.js";
import { Guest } from "../models/interfaces/general.interface.js";
import IJobApplication from "../models/schemas/jobApplication.js";
import { Job } from "../models/schemas/jobs.js";
import { JobLocation } from "../models/schemas/locations.js";
import IUser from "../models/schemas/user.js";
import { thresholdConditionOf } from "../models/schemas/thresholdCondition.js";

/** 'YYYY-MM-DD', or undefined for a missing / invalid date (never "1970-01-01"). */
export const sfDate = (d: unknown): string | undefined => {
    if (d === null || d === undefined || d === '') return undefined;
    const t = new Date(d as any);
    return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10);
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(',') : '');

export interface SalesforceContact {
    FirstName: string;
    LastName: string;
    Email: string;
    Phone: string;
    Birthdate?: string; // 'YYYY-MM-DD'
    AccountId: string,

    dateOfBirth_cambium__c?: string;
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
    ContactId?: string,

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
    /** תנאי סף (owner's request, 11.2026): only when the org has the field; null clears it. */
    Threshold_Condition__c?: string | null,
}

export interface SalesforceJobApplicationsCase {
    AccountId: string,
    RecordTypeId: string,
    /** The candidate's (or quick applicant's) Contact, when its Salesforce Id is known. */
    ContactId?: string,

    A_ID_cambium__c?: string, // application id
    A_PID_cambium__c?: string, // job id (same id as the job Case's PID_cambium__c, also for imported jobs)
    A_CID_cambium__c?: string, // candidate id (the Contact's ID_cambium__c)
    /** The candidate confirmed the job's threshold condition (תנאי סף), and when. Only when the org has the field. */
    Threshold_Confirmed__c?: boolean,
    Threshold_Confirmed_At__c?: string,
}

/**
 * Threshold condition (תנאי סף, owner's request 11.2026). Three custom fields on Case, each written only when the org
 * has it as a writable field of the right type (the connection check names any that is missing). A missing one is
 * SKIPPED, never a reason to refuse the record: the rest of the Case is still sent.
 *   job Case          Threshold_Condition__c     Long Text Area: the condition's text; null when the job has none
 *   application Case  Threshold_Confirmed__c     Checkbox: the candidate confirmed it (only for a job with a condition)
 *                     Threshold_Confirmed_At__c  Date/Time: when
 * The text as it was at confirmation time is not stored by the site, so it is not sent with the application.
 */
export const THRESHOLD_FIELDS = {
    condition: 'Threshold_Condition__c', confirmed: 'Threshold_Confirmed__c', confirmedAt: 'Threshold_Confirmed_At__c',
} as const;
const THRESHOLD_TYPES: Record<string, string[]> = {
    Threshold_Condition__c: ['textarea', 'string'], Threshold_Confirmed__c: ['boolean'], Threshold_Confirmed_At__c: ['datetime'],
    ID_Number__c: ['string'],
};
export type ThresholdFieldsInOrg = { condition?: boolean; confirmed?: boolean; confirmedAt?: boolean };
/** Is this optional field in the org, of the expected type, and may the integration user create and update it? */
export const usableOptionalField = (d: Describe | null, name: string): boolean => {
    const f = d?.fields.find((x) => x.name === name);
    return !!f && f.createable && f.updateable && (!THRESHOLD_TYPES[name] || THRESHOLD_TYPES[name].includes(f.type));
};
export const thresholdFieldsOf = (caseDescribe: Describe | null): ThresholdFieldsInOrg => ({
    condition: usableOptionalField(caseDescribe, THRESHOLD_FIELDS.condition),
    confirmed: usableOptionalField(caseDescribe, THRESHOLD_FIELDS.confirmed),
    confirmedAt: usableOptionalField(caseDescribe, THRESHOLD_FIELDS.confirmedAt),
});

/**
 * The candidate's Israeli ID number (תעודת זהות, owner's decision 11.2026): one custom Text(9) field on Contact,
 * written only when the org has it (created by the org admin; docs/salesforce.md). Without it nothing of the ID
 * number is sent. A number the candidate removed is sent as empty.
 */
export const ID_NUMBER_FIELD = 'ID_Number__c';
export type ContactFieldsInOrg = { idNumber?: boolean };
export const contactFieldsOf = (contactDescribe: Describe | null): ContactFieldsInOrg => ({
    idNumber: usableOptionalField(contactDescribe, ID_NUMBER_FIELD),
});

/**
 * Fields content managers added on the settings screen (docs/settings.md): a field goes to Salesforce ONLY when an
 * admin linked it to a custom field (…__c) AND the org has that field, writable by the integration user, of a type the
 * answer fits (text → Text / Long Text, list → Picklist / Text, checkbox → Checkbox). Anything else is skipped, never a
 * reason to refuse the record. Only active fields; an unanswered one is sent empty (null; false for a checkbox), so
 * clearing it on the site clears it there. The site never creates or deletes a field in Salesforce.
 */
export type CustomFieldLinkStatus = 'not_linked' | 'missing' | 'wrong_type' | 'not_writable' | 'ok';
export const customFieldLinkStatus = (def: Pick<CustomFieldDef, 'type' | 'sfField'>, d: Describe | null): CustomFieldLinkStatus => {
    if (!def.sfField) return 'not_linked';
    const f = d?.fields.find((x) => x.name === def.sfField);
    if (!f) return 'missing';
    if (!SF_TYPES[def.type].includes(f.type)) return 'wrong_type';
    if (!f.createable || !f.updateable) return 'not_writable';
    return 'ok';
};
export const customFieldsForSalesforce = (defs: readonly CustomFieldDef[], stored: unknown, d: Describe | null): Record<string, string | boolean | null> => {
    const v = asCustomValues(stored);
    const out: Record<string, string | boolean | null> = {};
    for (const def of defs) {
        if (!def.active || customFieldLinkStatus(def, d) !== 'ok') continue;
        const x = v[def.id];
        out[def.sfField!] = def.type === 'checkbox' ? x === true : (typeof x === 'string' && x ? x : null);
    }
    return out;
};

export const formatUserToSalesforceContact = (user: IUser, inOrg: ContactFieldsInOrg = {}): SalesforceContact => {
    const dob = sfDate(user.dateOfBirth);
    return {
        FirstName: str(user.firstName),
        LastName: str(user.lastName) || str(user.firstName) || '-', // LastName is required on a Contact
        Email: str(user.email),
        Phone: str(user.phoneNumber),
        ...(dob ? { Birthdate: dob } : {}),
        AccountId: appConfig.salesforce.contactsAccountId,

        ...(dob ? { dateOfBirth_cambium__c: dob } : {}),
        email_cambium__c: str(user.email),
        firstName_cambium__c: str(user.firstName),
        lastName_cambium__c: str(user.lastName),
        gender_cambium__c: str(user.gender),
        ID_cambium__c: str(user._id),
        citySymbol_cambium__c: str(user.citySymbol),
        phoneNumber_cambium__c: str(user.phoneNumber),
        skills_cambium__c: list(user.skills),
        CV_link_cambium__c: str(user.cvFileUrl),
        ...(inOrg.idNumber && user.idNumber !== undefined ? { [ID_NUMBER_FIELD]: user.idNumber || null } : {}),
    } as SalesforceContact;
};

export const formatGuestToSalesforceContact = (guest: Guest): SalesforceGuestContact => ({
    LastName: str(guest.fullName) || '-',
    Email: str(guest.email),
    AccountId: appConfig.salesforce.contactsAccountId,
    Phone: str(guest.phoneNumber),

    email_cambium__c: str(guest.email),
    lastName_cambium__c: str(guest.fullName),
    phoneNumber_cambium__c: str(guest.phoneNumber),
    ID_cambium__c: str(guest._id),
});

/**
 * A job Case, record type "Position" like the existing site's jobs, with the SAME fields only (owner's rule,
 * 11.2026: no new job fields). How the new site's data fits them:
 *   PStatus__c               Active / Suspended / Closed; an archived job (removed from the board) is sent as Closed
 *   PCreatedDate_cambium__c  the publish date (falls back to the creation date)
 *   PComments_cambium__c     the internal comments, plus a line with the external apply link when the job has one
 *   company_cambium__c       the company (employer) name; PSkills_cambium__c the skill ids, as the existing site sends
 *   ContactId                the employer's Contact, for a job an employer account posted (once that Contact exists)
 */
export const EXTERNAL_LINK_LINE = 'קישור חיצוני להגשה:';
export const formatJobToSalesforceJobCase = (
    job: Job, jobLocation: JobLocation | null | undefined, employerContactId?: string, inOrg: ThresholdFieldsInOrg = {},
): SalesforceJobsCase => ({
    AccountId: appConfig.salesforce.jobCaseAccountId,
    RecordTypeId: appConfig.salesforce.jobCaseRecordTypeId,
    ...(employerContactId ? { ContactId: employerContactId } : {}),
    isSponserd_cambium__c: !!job.isSponsored,
    isMarked_cambium__c: !!job.isMarked,
    isSelfApply_cambium__c: !!job.isSelfApply,
    company_cambium__c: str(job.companyName),
    Position_cambium__c: str(job.title),
    PLocation_cambium__c: str(jobLocation?.city),
    citySymbol_cambium__c: str(job.citySymbol),
    PTime_cambium__c: list(job.jobScope),
    PSkills_cambium__c: list(job.requiredSkills),
    PDescription_cambium__c: str(job.description),
    PComments_cambium__c: [str(job.comments), job.externalLink ? `${EXTERNAL_LINK_LINE} ${job.externalLink}` : ''].filter(Boolean).join('\n'),
    PFullName_cambium__c: str(job.contactPersonName),
    PPhone_cambium__c: str(job.contactPersonPhone),
    PEmail_cambium__c: str(job.contactPersonEmail),
    PID_cambium__c: str(job._id),
    // The job page is /job/<id> (the same form as the existing site's links: https://jobs.skeelz.co.il/job/<_id>).
    PLink_cambium__c: `${appConfig.clientBaseUrl.replace(/\/+$/, '')}/job/${job._id}`,
    PStatus__c: job.deletedAt ? 'Closed' : str(job.status),
    ...(isoOf(job.publishDate ?? job.createdAt) ? { PCreatedDate_cambium__c: isoOf(job.publishDate ?? job.createdAt) } : {}),
    ...(isoOf(job.updatedAt) ? { PModifiedDate_cambium__c: isoOf(job.updatedAt) } : {}),
    // Sent on every create and update, so removing the condition on the site clears it (null) on the same Case.
    ...(inOrg.condition ? { [THRESHOLD_FIELDS.condition]: thresholdConditionOf(job.thresholdCondition) } : {}),
});
const isoOf = (d: unknown): string | undefined => {
    if (d === null || d === undefined || d === '') return undefined;
    const t = new Date(d as any);
    return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
};

/** The fields an update of an existing job Case sends: the record type and Account stay as they are in Salesforce. */
export const jobCaseUpdateBody = (c: SalesforceJobsCase) => {
    const { AccountId: _a, RecordTypeId: _r, ...rest } = c;
    return rest;
};

export type ApplicationForSalesforce = Pick<IJobApplication, '_id' | 'jobId' | 'userId'> & {
    thresholdConfirmed?: boolean; thresholdConfirmedAt?: Date | string | null;
    /** The candidate's Contact key (its ID_cambium__c) when it differs from userId: a Contact of the existing site that
     *  was found by email and adopted. The new_applied Flow finds the Contact by A_CID_cambium__c = ID_cambium__c. */
    candidateKey?: string | null;
};
export const formatJobToSalesforceJobApplicationsCase = (
    jobApplication: ApplicationForSalesforce, contactSfId?: string, inOrg: ThresholdFieldsInOrg = {},
): SalesforceJobApplicationsCase => ({
    AccountId: appConfig.salesforce.jobApplicationsCaseAccountId,
    RecordTypeId: appConfig.salesforce.jobApplicationsCaseRecordTypeId,
    ...(contactSfId ? { ContactId: contactSfId } : {}),
    A_ID_cambium__c: str(jobApplication._id),
    A_PID_cambium__c: str(jobApplication.jobId),
    A_CID_cambium__c: str(jobApplication.candidateKey || jobApplication.userId),
    ...(inOrg.confirmed ? { [THRESHOLD_FIELDS.confirmed]: !!jobApplication.thresholdConfirmed } : {}),
    ...(inOrg.confirmedAt && jobApplication.thresholdConfirmed && isoOf(jobApplication.thresholdConfirmedAt)
        ? { [THRESHOLD_FIELDS.confirmedAt]: isoOf(jobApplication.thresholdConfirmedAt) } : {}),
});

/**
 * A registered employer (docs/employers.md) = an Account for the company they entered, and a Contact for the person,
 * under that Account (owner's rule, 11.2026). Both are found again by SKEELZ_Employer_Id__c (Text(24), External ID +
 * Unique, on Contact AND on Account: the employer's user id); without that field nothing of an employer is sent
 * (code employer_id_field_missing). Is_SKEELZ_Employer__c (Checkbox, Contact) is written when the org has it.
 * Every employer field of the site has a place: first / last name, email, phone, job title (Title) on the Contact;
 * the company name on the Account (Name).
 */
export interface SalesforceEmployerContact {
    FirstName: string;
    LastName: string;
    Email: string;
    Phone: string;
    Title?: string;
    Description: string;
    AccountId?: string;
    SKEELZ_Employer_Id__c: string;
    Is_SKEELZ_Employer__c?: boolean;
}
export interface SalesforceEmployerAccount {
    Name: string;
    RecordTypeId?: string;
    Description: string;
    SKEELZ_Employer_Id__c: string;
}

export const EMPLOYER_ID_FIELD = 'SKEELZ_Employer_Id__c';
export const EMPLOYER_FLAG_FIELD = 'Is_SKEELZ_Employer__c';
export const employerContactMarker = (userId: string) => `SKEELZ Jobs employer account ${userId}`;

export type EmployerForSalesforce = {
    id: string; firstName: string; lastName: string; email: string; phone: string; companyName: string; jobTitle: string | null;
};

export const formatEmployerToSalesforceAccount = (e: EmployerForSalesforce): SalesforceEmployerAccount => ({
    Name: (str(e.companyName).trim() || [str(e.firstName), str(e.lastName)].join(' ').trim() || '-').slice(0, 255),
    ...(appConfig.salesforce.employerAccountRecordTypeId ? { RecordTypeId: appConfig.salesforce.employerAccountRecordTypeId } : {}),
    Description: employerContactMarker(e.id),
    [EMPLOYER_ID_FIELD]: e.id,
} as SalesforceEmployerAccount);

/** An existing Account keeps its record type. */
export const employerAccountUpdateBody = (a: SalesforceEmployerAccount) => {
    const { RecordTypeId: _r, ...rest } = a;
    return rest;
};

export const formatEmployerToSalesforceContact = (
    e: EmployerForSalesforce, accountId?: string, optionalFields: { flagField?: boolean } = {},
): SalesforceEmployerContact => ({
    FirstName: str(e.firstName),
    LastName: str(e.lastName) || '-',
    Email: str(e.email),
    Phone: str(e.phone),
    ...(e.jobTitle ? { Title: e.jobTitle.slice(0, 128) } : {}),
    Description: employerContactMarker(e.id),
    ...(accountId ? { AccountId: accountId } : {}),
    [EMPLOYER_ID_FIELD]: e.id,
    ...(optionalFields.flagField ? { [EMPLOYER_FLAG_FIELD]: true } : {}),
} as SalesforceEmployerContact);

/** The CV file (ContentVersion) that goes with a Contact or an application Case. */
export const cvContentVersion = (s3Key: string, ownerMarker: string) => {
    const fileName = s3Key.split('/').pop() || 'cv.pdf';
    return { Title: fileName, PathOnClient: fileName, Description: ownerMarker };
};

/**
 * Every field this site writes, per object (for the connection check and the docs). Built from the formatters
 * themselves, so it can't drift from what is sent. `optional` fields are written only when the org has them.
 */
export const fieldsWritten = (): { object: 'Contact' | 'Case' | 'Account' | 'ContentVersion' | 'ContentDocumentLink'; kind: string; fields: string[]; optional?: string[]; optionalReason?: string; lookupField?: string }[] => {
    const user = formatUserToSalesforceContact({ _id: 'x', firstName: 'a', lastName: 'b', email: '', phoneNumber: '', dateOfBirth: '2000-01-01', gender: '', citySymbol: 1, skills: [], cvFileUrl: '' } as any);
    const guest = formatGuestToSalesforceContact({ _id: 'x', fullName: 'a', email: '', phoneNumber: '' });
    const job = formatJobToSalesforceJobCase({ _id: 'x', jobId: 1, createdAt: new Date(), updatedAt: new Date() } as any, { city: '' } as any, '003000000000000');
    const app = formatJobToSalesforceJobApplicationsCase({ _id: 'x', jobId: 'y', userId: 'z' }, '003000000000000');
    const empData = { id: 'x', firstName: '', lastName: '', email: '', phone: '', companyName: '', jobTitle: 't' };
    const emp = formatEmployerToSalesforceContact(empData, '001000000000000');
    const empAccount = formatEmployerToSalesforceAccount(empData);
    const keys = (o: object) => Object.keys(o);
    return [
        { object: 'Contact', kind: 'candidate', fields: keys(user), lookupField: 'ID_cambium__c' },
        { object: 'Contact', kind: 'guest', fields: keys(guest), lookupField: 'ID_cambium__c' },
        { object: 'Contact', kind: 'employer', fields: keys(emp), optional: [EMPLOYER_FLAG_FIELD], lookupField: EMPLOYER_ID_FIELD },
        { object: 'Account', kind: 'employer_account', fields: keys(empAccount), lookupField: EMPLOYER_ID_FIELD },
        { object: 'Case', kind: 'job', fields: keys(job), lookupField: 'PID_cambium__c' },
        { object: 'Case', kind: 'application', fields: keys(app), lookupField: 'A_ID_cambium__c' },
        // Threshold condition (תנאי סף): sent when the org has them, skipped (with a warning in the check) when not.
        { object: 'Case', kind: 'threshold', fields: [], optional: Object.values(THRESHOLD_FIELDS), optionalReason: 'threshold' },
        // The candidate's ID number: sent when the org has the field, skipped (with a warning in the check) when not.
        { object: 'Contact', kind: 'id_number', fields: [], optional: [ID_NUMBER_FIELD], optionalReason: 'id_number' },
        { object: 'ContentVersion', kind: 'cv', fields: [...Object.keys(cvContentVersion('a/b.pdf', 'm')), 'VersionData'] },
        { object: 'ContentDocumentLink', kind: 'cv', fields: ['ContentDocumentId', 'LinkedEntityId', 'ShareType', 'Visibility'] },
    ];
};

// ---- describe (what the org says about an object) ----
export type Describe = {
    name: string; createable: boolean; updateable: boolean;
    fields: { name: string; type: string; length: number; createable: boolean; updateable: boolean; filterable: boolean; externalId?: boolean }[];
    recordTypeInfos?: { recordTypeId: string; available: boolean; active?: boolean; developerName?: string; name?: string }[];
};
/**
 * The Beta mark (owner's rule, 11.2026): every Contact, Case and Account this site writes carries Beta = true, so the team's
 * current lists, reports and automations can leave them out. The field (SALESFORCE_BETA_FIELD, default Beta__c) must
 * exist on the object as a writable checkbox; otherwise NOTHING is sent (code beta_field_missing).
 */
export const DEFAULT_BETA_FIELD = 'Beta__c';
export const betaMark = (d: Describe | null, field: string, on = true): Record<string, true> => {
    // SALESFORCE_BETA_MARK=false (the cutover): nothing about Beta is written, and the field is no longer required.
    // A record marked earlier keeps its mark until the team clears it in Salesforce (the site never clears it).
    if (!on) return {};
    const f = d?.fields.find((x) => x.name === field);
    if (!f || f.type !== 'boolean' || !f.createable || !f.updateable) throw Object.assign(new Error('beta field missing'), { code: 'beta_field_missing' });
    return { [field]: true };
};

/** Text cut to the field's length in the org (a too-long value would refuse the whole record). */
export const fitToDescribe = <T extends Record<string, unknown>>(body: T, d: Describe | null): T => {
    if (!d) return body;
    const byName = new Map(d.fields.map((f) => [f.name, f]));
    const out: Record<string, unknown> = { ...body };
    for (const [k, v] of Object.entries(out)) {
        const f = byName.get(k);
        if (typeof v === 'string' && f && f.length > 0 && v.length > f.length) out[k] = v.slice(0, f.length);
    }
    return out as T;
};

/** On an adopted Contact the site fills only what is empty there; these it keeps current (when it has a value). */
export const ADOPTED_FILL_IF_EMPTY = ['FirstName', 'Phone', 'Birthdate', 'dateOfBirth_cambium__c', 'email_cambium__c', 'firstName_cambium__c',
    'lastName_cambium__c', 'gender_cambium__c', 'ID_cambium__c', 'citySymbol_cambium__c', 'phoneNumber_cambium__c', 'skills_cambium__c'] as const;
export const ADOPTED_KEEP_CURRENT = ['CV_link_cambium__c'] as const;
const emptyValue = (v: unknown) => v === null || v === undefined || v === '';

/**
 * The update an adopted Contact gets: fields empty in Salesforce are filled, the CV link is kept current, nothing is
 * ever cleared or overwritten (name, email, phone, Account and ID_cambium__c stay as the team and the existing site
 * left them). Pure: unit-tested.
 */
export const adoptedContactPatch = (body: Record<string, unknown>, current: Record<string, unknown>, extraFill: string[] = []): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of [...ADOPTED_FILL_IF_EMPTY, ...extraFill]) {
        if (!emptyValue(body[f]) && emptyValue(current[f])) out[f] = body[f];
    }
    for (const f of ADOPTED_KEEP_CURRENT) {
        if (!emptyValue(body[f]) && body[f] !== current[f]) out[f] = body[f];
    }
    return out;
};
