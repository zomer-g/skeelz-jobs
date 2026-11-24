/* ============================================================================
 *  Salesforce connection check: READ ONLY. Signs in (Client Credentials) and
 *  checks that everything the site writes exists and may be written by the
 *  integration user — objects, fields, the Account ids and the record type ids —
 *  without creating, changing or deleting anything.
 *
 *  Runs whenever the settings are complete, also while ENABLE_SALESFORCE is off
 *  (that is the point: check first, then switch on). Used by the admin screen
 *  (POST /api/admin/security/salesforce/check) and by `npm run sf:check`.
 *
 *  The report holds check names, ok/fail, codes and Salesforce metadata names
 *  (object / field / record type names) only: never the secret, a token or a record.
 * ========================================================================== */
import { allDefinitions as allCustomFieldDefinitions } from './customFieldsService.js';
import { salesforceObjectOf } from '../models/schemas/customFields.js';
import appConfig from '../config/appConfig.js';
import { getSalesforceConfig, resetSalesforceToken, sfQuery, sfRequest } from '../config/salesforceConfig.js';
import { queryOne } from '../config/db.js';
import { salesforceErrorCode } from '../internalApi/pure.js';
import { betaMark, customFieldLinkStatus, fieldsWritten, usableOptionalField } from '../utils/salesforceUtils.js';
import { Describe, resetDescribeCache, soqlId } from './salesforceService.js';

/** warn: ok (nothing is refused) but something is skipped — e.g. an optional field missing in the org. */
export type CheckItem = { id: string; ok: boolean; warn?: boolean; label: string; code?: string; detail?: string[] };
export type CheckReport = { ok: boolean; at: string; enabled: boolean; items: CheckItem[] };

const unique = <T,>(a: T[]) => [...new Set(a)];
/** Fields sent again on an update: every Contact field; an employer Account's except its record type; a job Case's
 *  except its Account and record type. */
const updatedLater = (object: string, kind: string, field: string) =>
  object === 'Contact' || (object === 'Account' && field !== 'RecordTypeId') || (kind === 'job' && field !== 'AccountId' && field !== 'RecordTypeId');

let lastReport: CheckReport | null = null;
export const lastCheckReport = () => lastReport;

export const runSalesforceCheck = async (): Promise<CheckReport> => {
  const s = appConfig.salesforce;
  const items: CheckItem[] = [];
  const add = (i: CheckItem) => { items.push(i); return i.ok; };
  const done = () => {
    lastReport = { ok: items.every((i) => i.ok), at: new Date().toISOString(), enabled: s.enableSalesforce, items };
    return lastReport;
  };

  if (!add({ id: 'settings', label: 'הגדרות בשרת (משתני סביבה)', ok: s.complete, ...(s.complete ? {} : { code: 'settings_incomplete', detail: s.problems }) })) return done();

  // 1. Sign-in (fresh: the check must see the permissions as they are now).
  resetSalesforceToken();
  resetDescribeCache();
  let instanceHost = '';
  try {
    const auth = await getSalesforceConfig({ fresh: true });
    instanceHost = new URL(auth.instance_url).host;
    add({ id: 'token', label: 'התחברות (Client Credentials)', ok: true, detail: [instanceHost] });
  } catch (e) {
    add({ id: 'token', label: 'התחברות (Client Credentials)', ok: false, code: salesforceErrorCode(e) });
    return done();
  }

  // 2. API version.
  try {
    const versions = await sfRequest<{ version: string }[]>('GET', '/services/data/');
    const want = s.apiVersion.replace(/^v/, '');
    const ok = Array.isArray(versions) && versions.some((v) => v.version === want);
    add({ id: 'api_version', label: `גרסת API ${s.apiVersion}`, ok, ...(ok ? {} : { code: 'api_version_not_available', detail: [`latest: v${versions?.at(-1)?.version ?? '?'}`] }) });
    if (!ok) return done();
  } catch (e) {
    add({ id: 'api_version', label: `גרסת API ${s.apiVersion}`, ok: false, code: salesforceErrorCode(e) });
    return done();
  }

  // 3. Objects and fields.
  const plan = fieldsWritten();
  const describes = new Map<string, Describe | null>();
  for (const object of unique(plan.map((p) => p.object))) {
    try { describes.set(object, await sfRequest<Describe>('GET', `sobjects/${object}/describe`)); }
    catch (e) {
      describes.set(object, null);
      add({ id: `object_${object}`, label: `גישה לאובייקט ${object}`, ok: false, code: salesforceErrorCode(e) });
    }
  }
  for (const [object, d] of describes) {
    if (!d) continue;
    const needsUpdate = object === 'Contact' || object === 'Case' || object === 'Account';
    const ok = d.createable && (!needsUpdate || d.updateable);
    add({ id: `object_${object}`, label: `יצירה${needsUpdate ? ' ועדכון' : ''} של ${object}`, ok, ...(ok ? {} : { code: 'object_not_writable' }) });
  }
  for (const p of plan) {
    const d = describes.get(p.object);
    if (!d) continue;
    const byName = new Map(d.fields.map((f) => [f.name, f]));
    const missing: string[] = [];
    const readOnly: string[] = [];
    for (const f of p.fields) {
      const fd = byName.get(f);
      if (!fd) missing.push(f);
      else if (!fd.createable || (updatedLater(p.object, p.kind, f) && !fd.updateable)) readOnly.push(f);
    }
    if (p.optionalReason) { /* only optional fields: reported below */ }
    else if (p.lookupField) {
      const lf = byName.get(p.lookupField);
      if (!lf && !p.fields.includes(p.lookupField)) missing.push(p.lookupField);
      else if (lf && !lf.filterable) readOnly.push(`${p.lookupField} (not filterable)`);
    }
    const ok = !missing.length && !readOnly.length;
    if (!p.optionalReason) add({
      id: `fields_${p.kind}`, label: `שדות ${p.object} (${p.kind})`, ok,
      ...(ok ? {} : { code: missing.length ? 'fields_missing' : 'fields_not_writable', detail: [...missing.map((f) => `missing: ${f}`), ...readOnly.map((f) => `no edit permission: ${f}`)] }),
    });
    if (p.optional && (p.optionalReason === 'threshold' || p.optionalReason === 'id_number')) {
      // Threshold condition (תנאי סף) on Case, the ID number on Contact: each field must be there, of the right type,
      // creatable + editable by the integration user. A missing one is skipped (the rest is still sent) and named here.
      const bad = p.optional.filter((f) => !usableOptionalField(d, f));
      const why = (f: string) => (!byName.get(f) ? 'missing (or no Read access)' : 'wrong type or no edit permission');
      const reason = p.optionalReason;
      add({ id: `fields_${reason}`, label: reason === 'threshold' ? `שדות תנאי סף ב-${p.object}` : `שדה תעודת זהות ב-${p.object}`, ok: true,
        ...(bad.length ? { warn: true, code: `${reason}_fields_missing` } : {}),
        detail: p.optional.map((f) => `${p.object}.${f}: ${bad.includes(f) ? `${why(f)} — skipped` : 'in use'}`) });
    } else if (p.optional) {
      const present = p.optional.filter((f) => byName.get(f)?.createable);
      add({ id: `optional_${p.kind}`, label: `שדות רשות ל${p.kind === 'employer' ? 'מעסיקים' : p.kind}`, ok: true,
        detail: p.optional.map((f) => `${f}: ${present.includes(f) ? 'in use' : 'not in the org (optional)'}`) });
    }
  }

  // 3a. Fields content managers added on the settings screen (docs/settings.md): each is sent only once an admin linked
  // it to a field the org has. A warning (not a failure) while an active one is unlinked or its field is missing.
  try {
    const defs = (await allCustomFieldDefinitions()).filter((d) => d.active);
    if (defs.length) {
      const lines = defs.map((d) => {
        const object = salesforceObjectOf(d.form);
        const st = customFieldLinkStatus(d, describes.get(object) ?? null);
        return { st, line: `${d.form === 'signup' ? 'sign-up' : 'job'} field ${d.id}: ${d.sfField ? `${object}.${d.sfField}` : 'not linked'} — ${st === 'ok' ? 'in use' : `${st}, not sent`}` };
      });
      const warn = lines.some((l) => l.st !== 'ok');
      add({ id: 'custom_fields', label: 'שדות שנוספו בהגדרות', ok: true, ...(warn ? { warn: true, code: 'custom_fields_not_sent' } : {}), detail: lines.map((l) => l.line) });
    }
  } catch { /* the settings table is read on the site's own database; never a reason to fail the check */ }

  // 3b. The Beta checkbox (owner's rule): without it nothing is sent — while the mark is on (SALESFORCE_BETA_MARK).
  if (!s.betaMarkOn) {
    add({ id: 'beta_off', label: 'סימון Beta', ok: true, detail: ['SALESFORCE_BETA_MARK=false: records are no longer marked Beta (earlier marks stay until cleared in Salesforce)'] });
  } else for (const object of ['Contact', 'Case', 'Account'] as const) {
    const d = describes.get(object);
    if (!d) continue;
    let ok = true;
    try { betaMark(d, s.betaField); } catch { ok = false; }
    add({ id: `beta_${object}`, label: `סימון Beta ב-${object} (${s.betaField})`, ok, ...(ok ? {} : { code: 'beta_field_missing', detail: [`${object}.${s.betaField}: a writable checkbox is required`] }) });
  }

  // 3c. The existing site's jobs (LEGACY_JOBS_MODE): after the cutover this site edits their Position Cases, which
  // belong to the existing site's integration user. Checked on one of them: may the integration user edit it?
  if (s.legacyJobsMode !== 'off') {
    try {
      const one = await queryOne<{ legacy_sf_id: string }>(`SELECT legacy_sf_id FROM jobs WHERE legacy_sf_id IS NOT NULL ORDER BY legacy_synced_at DESC NULLS LAST LIMIT 1`);
      if (!one) {
        add({ id: 'legacy_edit_access', label: 'עריכת משרות האתר הקיים ב-Salesforce', ok: true, warn: true, code: 'legacy_no_job_yet', detail: ['no job of the existing site read yet'] });
      } else {
        const me = await sfRequest<{ user_id?: string }>('GET', '/services/oauth2/userinfo');
        const rows = me?.user_id ? await sfQuery<{ HasEditAccess: boolean }>(
          `SELECT RecordId, HasEditAccess FROM UserRecordAccess WHERE UserId = '${soqlId(me.user_id)}' AND RecordId = '${soqlId(one.legacy_sf_id)}'`) : [];
        const ok = !!rows[0]?.HasEditAccess;
        add({ id: 'legacy_edit_access', label: 'עריכת משרות האתר הקיים ב-Salesforce', ok: ok || s.legacyJobsMode === 'mirror', ...(ok ? {} : {
          warn: s.legacyJobsMode === 'mirror', code: 'legacy_case_not_editable',
          detail: ['the integration user may not edit the existing site\'s Position Cases: a Sharing Rule (Read/Write on Position Cases) is needed before LEGACY_JOBS_MODE=owned'],
        }) });
      }
    } catch (e) {
      add({ id: 'legacy_edit_access', label: 'עריכת משרות האתר הקיים ב-Salesforce', ok: s.legacyJobsMode === 'mirror', warn: true, code: salesforceErrorCode(e) });
    }
  }

  // 4. Account ids.
  const accounts: [string, string][] = ([
    ['SALESFORCE_CONTACTS_ACCOUNT_ID', s.contactsAccountId],
    ['SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID', s.jobApplicationsCaseAccountId],
    ['SALESFORCE_CASE_ACCOUNT_ID', s.jobCaseAccountId],
  ] as [string, string][]).filter(([, v]) => !!v);
  try {
    const rows = await sfQuery<{ Id: string }>(`SELECT Id FROM Account WHERE Id IN (${unique(accounts.map(([, v]) => `'${soqlId(v)}'`)).join(',')})`);
    const found = new Set(rows.map((r) => r.Id.slice(0, 15)));
    const missing = accounts.filter(([, v]) => !found.has(v.slice(0, 15))).map(([k]) => k);
    add({ id: 'accounts', label: 'חשבונות (Account) קיימים', ok: !missing.length, ...(missing.length ? { code: 'account_not_found', detail: missing } : {}) });
  } catch (e) {
    add({ id: 'accounts', label: 'חשבונות (Account) קיימים', ok: false, code: salesforceErrorCode(e) });
  }

  // 5. Record types: exist, on Case, active, and available to the integration user.
  const rts: [string, string, 'Case' | 'Account'][] = ([
    ['SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID', s.jobApplicationsCaseRecordTypeId, 'Case'],
    ['SALESFORCE_CASE_RECORD_TYPE_ID', s.jobCaseRecordTypeId, 'Case'],
    ['SALESFORCE_EMPLOYER_ACCOUNT_RECORD_TYPE_ID', s.employerAccountRecordTypeId, 'Account'],
  ] as [string, string, 'Case' | 'Account'][]).filter(([, v]) => !!v);
  try {
    const rows = await sfQuery<{ Id: string; SobjectType: string; IsActive: boolean; DeveloperName: string }>(
      `SELECT Id, SobjectType, IsActive, DeveloperName FROM RecordType WHERE Id IN (${unique(rts.map(([, v]) => `'${soqlId(v)}'`)).join(',')})`);
    for (const [k, v, object] of rts) {
      const r = rows.find((x) => x.Id.slice(0, 15) === v.slice(0, 15));
      const info = (describes.get(object)?.recordTypeInfos ?? []).find((x) => x.recordTypeId?.slice(0, 15) === v.slice(0, 15));
      const code = !r ? 'record_type_not_found' : r.SobjectType !== object ? `record_type_not_${object.toLowerCase()}` : !r.IsActive ? 'record_type_inactive'
        : info && !info.available ? 'record_type_not_assigned' : undefined;
      const what = k.includes('JOBAPPLICATIONS') ? 'הגשות' : object === 'Account' ? 'חשבונות מעסיקים' : 'משרות';
      add({ id: `record_type_${k}`, label: `סוג רשומה ${what}`, ok: !code,
        ...(code ? { code } : {}), detail: [k, ...(r ? [r.DeveloperName] : [])] });
    }
  } catch (e) {
    add({ id: 'record_types', label: 'סוגי רשומה', ok: false, code: salesforceErrorCode(e) });
  }

  // 6. API usage left today (information).
  try {
    const l = await sfRequest<{ DailyApiRequests?: { Max: number; Remaining: number } }>('GET', 'limits');
    if (l?.DailyApiRequests) add({ id: 'limits', label: 'מכסת קריאות API היום', ok: l.DailyApiRequests.Remaining > 100,
      detail: [`${l.DailyApiRequests.Remaining} / ${l.DailyApiRequests.Max} left`] });
  } catch { /* the limits resource is optional for this check */ }

  return done();
};

/** For the console script: one line per item, no values. */
export const formatCheckReport = (r: CheckReport): string =>
  [`Salesforce connection check — ${r.ok ? 'OK' : 'FAILED'} (Salesforce is ${r.enabled ? 'ON' : 'OFF'} on this server)`,
    ...r.items.map((i) => `  ${!i.ok ? '✗' : i.warn ? '!' : '✓'} ${i.id}${i.code ? ` [${i.code}]` : ''}${i.detail?.length ? `: ${i.detail.join('; ')}` : ''}`)].join('\n');
