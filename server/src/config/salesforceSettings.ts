/* ============================================================================
 *  Salesforce settings: every one is an environment variable (docs/salesforce.md
 *  has the owner's table). Pure: reads a plain env object, so it is unit-tested.
 *
 *  ENABLE_SALESFORCE=true is the master switch. Salesforce is ON only when it is
 *  'true' AND every setting below passes; otherwise nothing at all is sent and the
 *  problems are printed at boot (names only, never a value) and shown to admins
 *  on the security screen. SANDBOX=true forces it off.
 * ========================================================================== */

export type SalesforceEnvVar = {
  name: string;
  required: boolean;
  secret: boolean;
  /** What it is, for the startup message, the admin screen and the docs. */
  about: string;
  /** Salesforce id prefix the value must start with (001 = Account, 012 = Record Type). */
  idPrefix?: '001' | '012';
};

export const SALESFORCE_ENV: readonly SalesforceEnvVar[] = [
  { name: 'SALESFORCE_LOGIN_URL', required: true, secret: false, about: 'the org\'s My Domain URL (https://<name>.my.salesforce.com)' },
  { name: 'SALESFORCE_CLIENT_ID', required: true, secret: false, about: 'Consumer Key of the External Client App' },
  { name: 'SALESFORCE_CLIENT_SECRET', required: true, secret: true, about: 'Consumer Secret of the External Client App' },
  { name: 'SALESFORCE_CONTACTS_ACCOUNT_ID', required: true, secret: false, idPrefix: '001', about: 'Account of candidates\' Contacts (registered and quick applications)' },
  { name: 'SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID', required: true, secret: false, idPrefix: '001', about: 'Account of application Cases' },
  { name: 'SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID', required: true, secret: false, idPrefix: '012', about: 'Case record type of applications' },
  { name: 'SALESFORCE_CASE_ACCOUNT_ID', required: true, secret: false, idPrefix: '001', about: 'Account of job Cases (jobs created on this site)' },
  { name: 'SALESFORCE_CASE_RECORD_TYPE_ID', required: true, secret: false, idPrefix: '012', about: 'Case record type of jobs' },
  { name: 'SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID', required: false, secret: false, idPrefix: '012', about: 'Account record type of employers\' companies (each employer gets an Account of its own; empty = the integration user\'s default)' },
  { name: 'SALESFORCE_API_VERSION', required: false, secret: false, about: 'REST API version, e.g. v62.0 (default v62.0)' },
  { name: 'SALESFORCE_BETA_FIELD', required: false, secret: false, about: 'API name of the Beta checkbox on Contact and Case (default Beta__c); every record sent is marked Beta' },
  { name: 'SALESFORCE_BETA_MARK', required: false, secret: false, about: 'true (default) = every record this site writes is marked Beta; false = no Beta mark is written (after the cutover)' },
  { name: 'LEGACY_JOBS_MODE', required: false, secret: false, about: 'jobs of the existing site: off (default) / mirror (read from Salesforce into this site, read-only here) / owned (this site manages them and writes their Cases)' },
  { name: 'LEGACY_PUBLIC_API', required: false, secret: false, about: 'public API of the existing site (https://jobs.skeelz.co.il/api), read with GET only while mirroring: job numbers, the formatted description, locations and skills' },
  { name: 'LEGACY_JOBS_MIRROR_MINUTES', required: false, secret: false, about: 'minutes between two reads of the jobs of the existing site from Salesforce (default 5, 1–60)' },
  { name: 'LEGACY_CANDIDATES_MODE', required: false, secret: false, about: 'candidates of the existing site: off (default) / mirror (read from Salesforce into this site; they can only view, not edit or apply) / owned (ordinary candidates here; their changes go to the same Contact)' },
  { name: 'LEGACY_CANDIDATES_MIRROR_MINUTES', required: false, secret: false, about: 'minutes between two reads of the existing site\'s candidates from Salesforce (default 60, 5–1440); everything is re-read once a day anyway' },
  { name: 'LEGACY_CANDIDATE_ACCOUNTS', required: false, secret: false, about: 'comma-separated Account ids whose Contacts are the existing candidates (default: SALESFORCE_CONTACTS_ACCOUNT_ID); e.g. the candidates account and the Retrain candidates account' },
];

export const LEGACY_JOBS_MODES = ['off', 'mirror', 'owned'] as const;
export type LegacyJobsMode = typeof LEGACY_JOBS_MODES[number];
export type LegacyCandidatesMode = LegacyJobsMode;

export const DEFAULT_API_VERSION = 'v62.0';

export type SalesforceSettings = {
  /** ENABLE_SALESFORCE=true was asked for. */
  requested: boolean;
  /** Requested, valid, and not a sandbox: the only state in which anything is sent. */
  enabled: boolean;
  /** Readable problems, naming the variable, never its value. */
  problems: string[];
  /** Every required setting is present and valid (whether or not it is switched on): the connection check may run. */
  complete: boolean;
  clientId: string;
  clientSecret: string;
  loginUrl: string;
  apiVersion: string;
  contactsAccountId: string;
  /** Record type of the Account made for each employer's company ('' = the default one). */
  employerAccountRecordTypeId: string;
  jobCaseAccountId: string;
  jobCaseRecordTypeId: string;
  jobApplicationsCaseAccountId: string;
  jobApplicationsCaseRecordTypeId: string;
  /** Checkbox set to true on every Contact and Case written (salesforceUtils.betaMark). */
  betaField: string;
  /** SALESFORCE_BETA_MARK: false = the Beta mark is no longer written (nor required) — the cutover. */
  betaMarkOn: boolean;
  /** LEGACY_JOBS_MODE (services/legacyJobs.ts): the existing site's jobs. */
  legacyJobsMode: LegacyJobsMode;
  /** LEGACY_PUBLIC_API without a trailing slash ('' = not used). */
  legacyPublicApi: string;
  legacyMirrorMinutes: number;
  /** LEGACY_CANDIDATES_MODE (services/legacyCandidates.ts): the existing site's candidates. */
  legacyCandidatesMode: LegacyCandidatesMode;
  /** The Accounts whose Contacts are mirrored (LEGACY_CANDIDATE_ACCOUNTS, default the candidates' Account). */
  legacyCandidateAccounts: string[];
  /** LEGACY_CANDIDATES_MIRROR_MINUTES (default 60): candidates change rarely and can't edit here before the cutover. */
  legacyCandidatesMirrorMinutes: number;
};

const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
/** A My Domain host (production or sandbox), https, no path. */
const MY_DOMAIN = /^https:\/\/[a-z0-9-]+(?:--[a-z0-9]+)?(?:\.sandbox|\.develop|\.scratch)?\.my\.salesforce\.com$/i;
/** Local mock (test/helpers/mockSalesforce.mjs), honoured only with DEV_MODE=true. */
const LOCAL_MOCK = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/;

export const normalizeApiVersion = (v: string): string | null => {
  const m = /^v?(\d{2,3})\.0$/.exec(v.trim());
  return m ? `v${m[1]}.0` : null;
};

export const readSalesforceSettings = (env: Record<string, string | undefined>): SalesforceSettings => {
  const get = (k: string) => String(env[k] ?? '').trim();
  const problems: string[] = [];
  const devMode = env.DEV_MODE === 'true';

  for (const v of SALESFORCE_ENV) {
    const value = get(v.name);
    if (!value) {
      if (v.required) problems.push(`${v.name} is missing (${v.about})`);
      continue;
    }
    if (v.idPrefix && (!SF_ID.test(value) || !value.startsWith(v.idPrefix))) {
      problems.push(`${v.name} is not a Salesforce ${v.idPrefix === '001' ? 'Account' : 'Record Type'} id (15 or 18 letters and digits, starting with ${v.idPrefix})`);
    }
  }

  const loginUrl = get('SALESFORCE_LOGIN_URL').replace(/\/+$/, '');
  if (loginUrl) {
    if (/^https:\/\/(login|test)\.salesforce\.com$/i.test(loginUrl)) {
      problems.push('SALESFORCE_LOGIN_URL must be the org\'s My Domain URL (https://<name>.my.salesforce.com), not login/test.salesforce.com: the Client Credentials flow works only there');
    } else if (!MY_DOMAIN.test(loginUrl) && !(devMode && LOCAL_MOCK.test(loginUrl))) {
      problems.push('SALESFORCE_LOGIN_URL is not a My Domain URL (https://<name>.my.salesforce.com, no path)');
    }
  }

  const rawVersion = get('SALESFORCE_API_VERSION');
  const apiVersion = rawVersion ? normalizeApiVersion(rawVersion) : DEFAULT_API_VERSION;
  if (!apiVersion) problems.push('SALESFORCE_API_VERSION is not a version like v62.0');

  const betaField = get('SALESFORCE_BETA_FIELD') || 'Beta__c';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,38}__c$/.test(betaField)) problems.push('SALESFORCE_BETA_FIELD is not a custom field API name (like Beta__c)');

  const rawBeta = get('SALESFORCE_BETA_MARK').toLowerCase();
  if (rawBeta && rawBeta !== 'true' && rawBeta !== 'false') problems.push('SALESFORCE_BETA_MARK must be true or false');
  const betaMarkOn = rawBeta !== 'false';

  const rawMode = get('LEGACY_JOBS_MODE').toLowerCase();
  const legacyJobsMode: LegacyJobsMode = (LEGACY_JOBS_MODES as readonly string[]).includes(rawMode) ? rawMode as LegacyJobsMode : 'off';
  if (rawMode && legacyJobsMode !== rawMode) problems.push('LEGACY_JOBS_MODE must be off, mirror or owned');
  const legacyPublicApi = get('LEGACY_PUBLIC_API').replace(/\/+$/, '');
  if (legacyPublicApi && !/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?$/i.test(legacyPublicApi)
      && !(devMode && /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}(?:\/[A-Za-z0-9._~/-]*)?$/.test(legacyPublicApi))) {
    problems.push('LEGACY_PUBLIC_API is not an https URL (like https://jobs.skeelz.co.il/api)');
  }
  const rawMinutes = get('LEGACY_JOBS_MIRROR_MINUTES');
  const minutes = rawMinutes ? Number(rawMinutes) : 5;
  if (rawMinutes && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 60)) problems.push('LEGACY_JOBS_MIRROR_MINUTES must be a whole number from 1 to 60');
  const legacyMirrorMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : 5;
  const rawCandMode = get('LEGACY_CANDIDATES_MODE').toLowerCase();
  const legacyCandidatesMode: LegacyCandidatesMode = (LEGACY_JOBS_MODES as readonly string[]).includes(rawCandMode) ? rawCandMode as LegacyCandidatesMode : 'off';
  if (rawCandMode && legacyCandidatesMode !== rawCandMode) problems.push('LEGACY_CANDIDATES_MODE must be off, mirror or owned');
  const rawCandMinutes = get('LEGACY_CANDIDATES_MIRROR_MINUTES');
  const candMinutes = Number(rawCandMinutes);
  const candMinutesOk = Number.isInteger(candMinutes) && candMinutes >= 5 && candMinutes <= 1440;
  if (rawCandMinutes && !candMinutesOk) problems.push('LEGACY_CANDIDATES_MIRROR_MINUTES must be a whole number from 5 to 1440');
  const legacyCandidatesMirrorMinutes = candMinutesOk ? candMinutes : 60;
  const rawAccounts = get('LEGACY_CANDIDATE_ACCOUNTS');
  const legacyCandidateAccounts = [...new Set((rawAccounts ? rawAccounts.split(',') : [get('SALESFORCE_CONTACTS_ACCOUNT_ID')]).map((a) => a.trim()).filter(Boolean))];
  if (legacyCandidateAccounts.some((a) => !SF_ID.test(a) || !a.startsWith('001'))) {
    problems.push('LEGACY_CANDIDATE_ACCOUNTS must be Salesforce Account ids (starting with 001), separated by commas');
  }

  const requested = get('ENABLE_SALESFORCE') === 'true';
  const sandbox = get('SANDBOX') === 'true';
  const complete = problems.length === 0;
  return {
    requested,
    enabled: requested && complete && !sandbox,
    problems: sandbox && requested ? [...problems, 'SANDBOX=true: Salesforce is always off in the sandbox'] : problems,
    complete,
    clientId: get('SALESFORCE_CLIENT_ID'),
    clientSecret: get('SALESFORCE_CLIENT_SECRET'),
    loginUrl,
    apiVersion: apiVersion ?? DEFAULT_API_VERSION,
    contactsAccountId: get('SALESFORCE_CONTACTS_ACCOUNT_ID'),
    employerAccountRecordTypeId: get('SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID'),
    jobCaseAccountId: get('SALESFORCE_CASE_ACCOUNT_ID'),
    jobCaseRecordTypeId: get('SALESFORCE_CASE_RECORD_TYPE_ID'),
    jobApplicationsCaseAccountId: get('SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID'),
    jobApplicationsCaseRecordTypeId: get('SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID'),
    betaField,
    betaMarkOn,
    legacyJobsMode,
    legacyPublicApi,
    legacyMirrorMinutes,
    legacyCandidatesMode,
    legacyCandidateAccounts,
    legacyCandidatesMirrorMinutes,
  };
};

/** The boot line(s): never a value, only names and the state. */
export const salesforceBootMessage = (s: SalesforceSettings): { level: 'log' | 'error'; text: string } => {
  if (!s.requested) {
    return s.problems.length && s.clientId
      ? { level: 'log', text: '[salesforce] off (ENABLE_SALESFORCE is not true); settings are incomplete: ' + s.problems.join('; ') }
      : { level: 'log', text: '[salesforce] off (ENABLE_SALESFORCE is not true): nothing is sent' };
  }
  if (!s.enabled) return { level: 'error', text: `[salesforce] ENABLE_SALESFORCE=true but Salesforce stays OFF, nothing is sent: ${s.problems.join('; ')}` };
  return { level: 'log', text: `[salesforce] on (API ${s.apiVersion}; Beta mark ${s.betaMarkOn ? 'on' : 'off'}; existing site's jobs: ${s.legacyJobsMode}; candidates: ${s.legacyCandidatesMode})` };
};
