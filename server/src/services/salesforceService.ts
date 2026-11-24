/* ============================================================================
 *  Salesforce operations. All of them are idempotent: a record is found by the
 *  Salesforce Id stored last time, else by its id field (ID_cambium__c,
 *  PID_cambium__c, A_ID_cambium__c, SKEELZ_Employer_Id__c), then updated, or
 *  created only when it is not there. Nothing is ever deleted in Salesforce.
 *
 *  Callers go through services/salesforceSync.ts (the queue, the log entry, the
 *  stored state). Every function refuses when Salesforce is off, before any call.
 *  No response body, token or field value is logged; errors are reduced to a
 *  code by salesforceErrorCode() at the caller.
 * ========================================================================== */
import { definitionsOf as customFieldDefs } from './customFieldsService.js';
import appConfig from '../config/appConfig.js';
import { sfQuery, sfRequest } from '../config/salesforceConfig.js';
import IUser from '../models/schemas/user.js';
import { streamToBuffer } from '../utils/utils.js';
import {
    ADOPTED_FILL_IF_EMPTY, ADOPTED_KEEP_CURRENT, adoptedContactPatch, ID_NUMBER_FIELD, EMPLOYER_FLAG_FIELD, EMPLOYER_ID_FIELD, EmployerForSalesforce, cvContentVersion, formatEmployerToSalesforceContact,
    formatEmployerToSalesforceAccount, employerAccountUpdateBody,
    formatGuestToSalesforceContact, formatJobToSalesforceJobApplicationsCase, formatJobToSalesforceJobCase,
    formatUserToSalesforceContact, contactFieldsOf, jobCaseUpdateBody, fitToDescribe, betaMark, Describe, thresholdFieldsOf, customFieldsForSalesforce,
    ApplicationForSalesforce,
} from '../utils/salesforceUtils.js';
export type { Describe } from '../utils/salesforceUtils.js';
import { Job } from '../models/schemas/jobs.js';
import { JobLocation } from '../models/schemas/locations.js';
import { getFileFromS3 } from './s3Service.js';
import { fullContactPatch, isSfCvKey } from './legacyCandidatesPure.js';
import { Guest } from '../models/interfaces/general.interface.js';

export class SalesforceDisabledError extends Error { code = 'salesforce_disabled'; constructor() { super('Salesforce is disabled'); } }
const assertEnabled = () => { if (!appConfig.salesforce.enableSalesforce) throw new SalesforceDisabledError(); };

// Ids go into SOQL strings and URLs: only our own 24-hex ids / random ids and Salesforce ids are allowed.
export const soqlId = (id: unknown): string => {
    const s = String(id ?? '');
    if (!/^[A-Za-z0-9]{15,40}$/.test(s)) throw new Error('invalid id for SOQL');
    return s;
};
/** SOQL string literal: backslash and quote escaped. */
export const soqlString = (v: string) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// ---- describe (cached per process): field lengths to fit text, optional fields, record types ----
const describes = new Map<string, Promise<Describe>>();
export const describeObject = (name: string): Promise<Describe> => {
    let p = describes.get(name);
    if (!p) {
        p = sfRequest<Describe>('GET', `sobjects/${name}/describe`);
        p.catch(() => describes.delete(name));
        describes.set(name, p);
    }
    return p;
};
export const resetDescribeCache = () => describes.clear();

type Writable = 'Contact' | 'Case' | 'Account';
/**
 * What is written to a Contact, Case or Account: text cut to the field lengths, plus the Beta mark while it is on
 * (SALESFORCE_BETA_MARK; never sent without it then). `beta: false` = a record of the existing site this site updates
 * (the Position Case of one of its jobs after the cutover): never marked, it is the team's record.
 */
const fit = async <T extends Record<string, unknown>>(object: Writable, body: T, opts: { beta?: boolean } = {}): Promise<T> => {
    const d = await describeObject(object);
    const beta = opts.beta === false ? {} : betaMark(d, appConfig.salesforce.betaField, appConfig.salesforce.betaMarkOn);
    return { ...fitToDescribe(body, d), ...beta } as T;
};

// ---- generic find / update-or-create ----
const findId = async (object: Writable, field: string, value: string): Promise<string | undefined> => {
    const rows = await sfQuery<{ Id: string }>(`SELECT Id FROM ${object} WHERE ${field} = '${soqlId(value)}' LIMIT 1`);
    return rows[0]?.Id ? String(rows[0].Id) : undefined;
};

/**
 * Cases keep the integration user as their owner (owner's rule, 11.2026): the REST API applies the active Case
 * assignment rules unless told not to, so every Case write says so.
 */
export const NO_AUTO_ASSIGN = { headers: { 'Sforce-Auto-Assign': 'FALSE' } };
const extraFor = (object: Writable) => (object === 'Case' ? NO_AUTO_ASSIGN : {});

export const patchOrCreate = async (
    object: Writable, existingId: string | undefined, updateBody: object, createBody: object,
): Promise<{ id: string; created: boolean }> => {
    if (existingId) {
        try {
            await sfRequest('PATCH', `sobjects/${object}/${soqlId(existingId)}`, updateBody, extraFor(object));
            return { id: existingId, created: false };
        } catch (e: any) {
            // Removed in Salesforce (or merged away): create it again below.
            if (e?.response?.status !== 404) throw e;
        }
    }
    const r = await sfRequest<{ id?: string }>('POST', `sobjects/${object}/`, createBody, extraFor(object));
    if (!r?.id) throw new Error('Salesforce returned no id');
    return { id: String(r.id), created: true };
};

// ---- the records ----

/**
 * Job Case (PID_cambium__c = job id). Never called for a job imported from the existing site, nor for one of its jobs
 * while it is mirrored (salesforceSync.ts). After the cutover (legacy_state 'owned') the existing site's job updates
 * ITS Position Case - found by the id the mirror stored, else by PID_cambium__c - without the Beta mark and without
 * changing its record type, Account, owner or Case status (jobCaseUpdateBody). Only a job with no Case gets a new one.
 */
export const upsertJobCase = async (job: Job, jobLocation: JobLocation | null, knownId?: string, employerContactId?: string) => {
    assertEnabled();
    if ((job as any).importedFromLive) throw Object.assign(new Error('imported job'), { code: 'imported_read_only' });
    const legacy = job.legacyState === 'owned';
    const id = knownId || (legacy && job.legacySfId ? soqlId(job.legacySfId) : undefined) || await findId('Case', 'PID_cambium__c', String(job._id));
    // Threshold condition field: written when the org has it, skipped when not (salesforceUtils.THRESHOLD_FIELDS).
    const caseDescribe = await describeObject('Case');
    const inOrg = thresholdFieldsOf(caseDescribe);
    const body = formatJobToSalesforceJobCase(job, jobLocation, employerContactId, inOrg) as any;
    // Added job fields an admin linked to a Case field the org has (docs/settings.md); the rest are skipped.
    Object.assign(body, customFieldsForSalesforce(await customFieldDefs('job'), (job as any).customFields, caseDescribe));
    const create = await fit('Case', body);
    const update = legacy && id ? jobCaseUpdateBody(await fit('Case', body, { beta: false })) : jobCaseUpdateBody(create);
    return patchOrCreate('Case', id, update, create);
};

/**
 * Contacts of the candidates' Account (SALESFORCE_CONTACTS_ACCOUNT_ID) with this email, newest first (owner's decision,
 * 11.2026: the same person is the same Contact). The email is verified on this site (sign-in by email code, Google or
 * Microsoft), so a candidate can't take over someone else's Contact by typing an address. Quick (guest) applications
 * never use this: their email is not verified.
 */
export const findContactsByEmail = async (email: string): Promise<{ Id: string; ID_cambium__c: string | null }[]> => {
    const e = String(email ?? '').trim();
    if (!e || e.length > 254 || !/^[^\s@'"\\]+@[^\s@'"\\]+$/.test(e)) return [];
    const d = await describeObject('Contact');
    const by = ['Email', 'email_cambium__c'].filter((n) => d.fields.some((f) => f.name === n && f.filterable));
    if (!by.length) return [];
    const where = by.map((n) => `${n} = ${soqlString(e)}`).join(' OR ');
    return sfQuery<{ Id: string; ID_cambium__c: string | null }>(
        `SELECT Id, ID_cambium__c FROM Contact WHERE AccountId = '${soqlId(appConfig.salesforce.contactsAccountId)}' AND (${where}) ORDER BY LastModifiedDate DESC LIMIT 10`);
};

export type ContactResult = { id: string; created: boolean; legacyCid?: string | null; match?: 'email' | 'email_ambiguous' | null };

/**
 * Candidate Contact. Found by the id stored last time, else by ID_cambium__c = user id (a Contact this site made), else
 * (owner's decision, 11.2026) by the candidate's email (findContactsByEmail): one of the existing site's Contacts is
 * ADOPTED instead of making a second one for the same person. An adopted Contact keeps its ID_cambium__c (returned as
 * legacyCid: the application Cases carry it in A_CID_cambium__c), is never marked Beta, and gets only the careful
 * update above. Several Contacts with that email: the newest is adopted and the match is 'email_ambiguous' (counted for
 * admins). `ours(ids)` = those of the found Contacts this site made itself (never adopted: a quick applicant's, say).
 */
export const upsertContact = async (
    user: IUser, known: { id?: string; legacyCid?: string | null; full?: boolean } = {}, ours: (ids: string[]) => Promise<Set<string>> = async () => new Set(),
): Promise<ContactResult> => {
    assertEnabled();
    const d = await describeObject('Contact');
    // The ID number field: written when the org has it, skipped when not (salesforceUtils.ID_NUMBER_FIELD).
    const inOrg = contactFieldsOf(d);
    const raw = formatUserToSalesforceContact(user, inOrg) as any;
    // Added sign-up questions an admin linked to a Contact field the org has (docs/settings.md); the rest are skipped.
    Object.assign(raw, customFieldsForSalesforce(await customFieldDefs('signup'), (user as any).customFields, d));

    let id = known.id;
    let legacyCid = known.legacyCid ?? null;
    let match: ContactResult['match'] = null;
    if (!id) id = await findId('Contact', 'ID_cambium__c', String(user._id));
    if (!id) {
        const found = await findContactsByEmail(String(user.email ?? ''));
        const mine = found.length ? await ours(found.map((c) => String(c.Id))) : new Set<string>();
        const theirs = found.filter((c) => !mine.has(String(c.Id)));
        if (theirs.length) {
            id = String(theirs[0].Id);
            legacyCid = theirs[0].ID_cambium__c ? String(theirs[0].ID_cambium__c) : String(user._id); // empty: it gets ours
            match = theirs.length > 1 ? 'email_ambiguous' : 'email';
        }
    }

    if (id && legacyCid && known.full) {
        // A candidate of the existing site copied here before the cutover (sync match 'mirror'), after it (owner,
        // 20.11.2026: full writing): every value this site has goes to THEIR Contact; nothing cleared, never
        // ID_cambium__c, the Account or Beta (legacyCandidatesPure.fullContactPatch).
        const patch = fitToDescribe(fullContactPatch(raw, appConfig.salesforce.betaField), d);
        try {
            if (Object.keys(patch).length) await sfRequest('PATCH', `sobjects/Contact/${soqlId(id)}`, patch);
            return { id, created: false, legacyCid, match: null };
        } catch (e: any) {
            // Removed or merged away in Salesforce: looked up again below like anyone else.
            if (e?.response?.status !== 404) throw e;
            id = undefined; legacyCid = null;
        }
    }
    if (!id) id = await findId('Contact', 'ID_cambium__c', String(user._id));
    if (id && legacyCid) {
        // Adopted: read what is there, fill only the empty fields, keep the CV link current; never Beta.
        // The ID number and linked added fields: filled only where the Contact has nothing yet.
        const extra = [...(inOrg.idNumber ? [ID_NUMBER_FIELD] : []), ...Object.keys(customFieldsForSalesforce(await customFieldDefs('signup'), (user as any).customFields, d))];
        const fields = [...new Set<string>([...ADOPTED_FILL_IF_EMPTY, ...ADOPTED_KEEP_CURRENT, ...extra])]
            .filter((f) => d.fields.some((x) => x.name === f));
        const rows = await sfQuery<Record<string, unknown>>(`SELECT Id, ${fields.join(', ')} FROM Contact WHERE Id = '${soqlId(id)}' LIMIT 1`);
        if (rows[0]) {
            const patch = fitToDescribe(adoptedContactPatch(raw, rows[0], extra), d);
            if (Object.keys(patch).length) await sfRequest('PATCH', `sobjects/Contact/${soqlId(id)}`, patch);
            return { id, created: false, legacyCid, match };
        }
        // Removed or merged away in Salesforce: a Contact of our own is made below.
        id = undefined; legacyCid = null; match = null;
    }
    const body = await fit('Contact', raw);
    const r = await patchOrCreate('Contact', id, body, body);
    return { ...r, legacyCid: null, match: null };
};

/** Quick (guest) applicant's Contact (ID_cambium__c = the guest id). */
export const upsertGuestContact = async (guest: Guest, knownId?: string) => {
    assertEnabled();
    const id = knownId || await findId('Contact', 'ID_cambium__c', String(guest._id));
    const body = await fit('Contact', formatGuestToSalesforceContact(guest) as any);
    return patchOrCreate('Contact', id, body, body);
};

/** Application Case (A_ID_cambium__c = application id). Created once; an existing one is left as it is. */
export const ensureApplicationCase = async (
    jobApplication: ApplicationForSalesforce, contactSfId: string | undefined, knownId?: string,
) => {
    assertEnabled();
    const id = knownId || await findId('Case', 'A_ID_cambium__c', String(jobApplication._id));
    if (id) return { id, created: false };
    // The confirmation is known when the application is made, so it goes with the Case when it is created.
    const inOrg = thresholdFieldsOf(await describeObject('Case'));
    const body = await fit('Case', formatJobToSalesforceJobApplicationsCase(jobApplication, contactSfId, inOrg) as any);
    const r = await sfRequest<{ id?: string }>('POST', 'sobjects/Case/', body, NO_AUTO_ASSIGN);
    if (!r?.id) throw new Error('Salesforce returned no id');
    return { id: String(r.id), created: true };
};

/** The employer id field must be on Contact and Account (writable, searchable): it is how both are found again. */
const employerFieldsOf = async () => {
    const [contact, account] = await Promise.all([describeObject('Contact'), describeObject('Account')]);
    const usable = (d: Describe, n: string) => !!d.fields.some((f) => f.name === n && f.createable && f.updateable && f.filterable);
    if (!usable(contact, EMPLOYER_ID_FIELD) || !usable(account, EMPLOYER_ID_FIELD)) {
        throw Object.assign(new Error('employer id field missing'), { code: 'employer_id_field_missing' });
    }
    return { flagField: !!contact.fields.some((f) => f.name === EMPLOYER_FLAG_FIELD && f.createable && f.updateable) };
};

/**
 * A registered employer: the company's Account, then the person's Contact under it. Each is found by the stored Id,
 * else by SKEELZ_Employer_Id__c; updated, or created. Only records carrying the employer's own id are ever touched
 * (an Account the team made is never found, renamed or marked Beta by this).
 */
export const upsertEmployer = async (e: EmployerForSalesforce, known: { contactId?: string; accountId?: string } = {}) => {
    assertEnabled();
    const optional = await employerFieldsOf();
    const accountBody = await fit('Account', formatEmployerToSalesforceAccount(e) as any);
    const account = await patchOrCreate('Account', known.accountId || await findId('Account', EMPLOYER_ID_FIELD, e.id),
        employerAccountUpdateBody(accountBody), accountBody);
    try {
        const body = await fit('Contact', formatEmployerToSalesforceContact(e, account.id, optional) as any);
        const contact = await patchOrCreate('Contact', known.contactId || await findId('Contact', EMPLOYER_ID_FIELD, e.id), body, body);
        return { ...contact, accountId: account.id };
    } catch (err) {
        throw Object.assign(err as object, { accountId: account.id });
    }
};

/**
 * Uploads one CV file (from our private storage) once and links it to each record in `linkTo` (Case and/or Contact).
 * A link that already exists is fine. Returns the ContentDocument Id. The caller records the CV key it sent, so the
 * same file is never uploaded twice for the same record.
 */
export const attachCv = async (s3Key: string, linkTo: string[], ownerMarker: string): Promise<string> => {
    assertEnabled();
    const targets = linkTo.filter(Boolean).map(soqlId);
    if (!targets.length) throw new Error('no record to attach the CV to');
    let versionId: string;
    if (isSfCvKey(s3Key)) {
        // A CV of the existing site's candidate is already a file in Salesforce: linked, never uploaded again.
        versionId = s3Key.slice(3);
    } else {
        const buffer = await streamToBuffer(await getFileFromS3(s3Key));
        const version = await sfRequest<{ id?: string }>('POST', 'sobjects/ContentVersion',
            { ...cvContentVersion(s3Key, ownerMarker), VersionData: buffer.toString('base64') });
        if (!version?.id) throw Object.assign(new Error('no ContentVersion id'), { code: 'sf_no_content_version' });
        versionId = version.id;
    }
    const rows = await sfQuery<{ ContentDocumentId: string }>(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${soqlId(versionId)}'`);
    const documentId = rows[0]?.ContentDocumentId;
    if (!documentId) throw Object.assign(new Error('no ContentDocument id'), { code: 'sf_no_content_document' });
    for (const target of targets) {
        try {
            await sfRequest('POST', 'sobjects/ContentDocumentLink',
                { ContentDocumentId: soqlId(documentId), LinkedEntityId: target, ShareType: 'V', Visibility: 'AllUsers' });
        } catch (err: any) {
            if (err?.response?.data?.[0]?.errorCode !== 'DUPLICATE_VALUE') throw err;
        }
    }
    return String(documentId);
};
