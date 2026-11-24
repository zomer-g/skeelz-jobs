import { NextFunction, Request, Response } from 'express';
import { AxiosError } from 'axios';
import { GlobalErrorCodes, GlobalErrorMessages } from '../i18n/i18n.js';
import * as settingsService from '../services/settingsService.js';
import { ApplyPolicy, isValidPolicyValue, POLICY_FIELDS } from '../models/schemas/applyPolicy.js';
import { actorOf, auditDenied, writeAudit } from '../security/audit.js';
import { isEmployerPostingMode } from '../security/employer.js';
import { isSignupFieldMode, SIGNUP_FIELDS, signupFieldModes, SignupFieldsSetting } from '../security/pure.js';
import * as customFields from '../services/customFieldsService.js';
import { changedKeys, checkDefinition, CUSTOM_FIELD_LIMITS, CustomFieldDef, formFields, isCustomFieldForm, salesforceObjectOf, SF_FIELD_RE } from '../models/schemas/customFields.js';
import appConfig from '../config/appConfig.js';
import { salesforceEnabled } from '../services/salesforceSync.js';
import { describeObject, resetDescribeCache } from '../services/salesforceService.js';
import { customFieldLinkStatus, CustomFieldLinkStatus, Describe, fieldsWritten } from '../utils/salesforceUtils.js';

// ---- Salesforce link of added fields (docs/settings.md "Salesforce") ---------------------------------------------
export type SalesforceFieldStatus = CustomFieldLinkStatus | 'salesforce_off' | 'unknown';
/** Per added field: is it sent to Salesforce? Read-only (describe). `fresh` re-reads the org (after creating a field). */
const salesforceStatuses = async (defs: CustomFieldDef[], fresh = false): Promise<{ enabled: boolean; status: Record<string, SalesforceFieldStatus> }> => {
  const enabled = salesforceEnabled();
  const status: Record<string, SalesforceFieldStatus> = {};
  if (fresh && enabled) resetDescribeCache();
  const describes = new Map<string, Describe | null>();
  for (const d of defs) {
    if (!d.sfField) { status[d.id] = 'not_linked'; continue; }
    if (!enabled) { status[d.id] = 'salesforce_off'; continue; }
    const object = salesforceObjectOf(d.form);
    if (!describes.has(object)) describes.set(object, await describeObject(object).catch(() => null));
    const desc = describes.get(object) ?? null;
    status[d.id] = desc ? customFieldLinkStatus(d, desc) : 'unknown';
  }
  return { enabled, status };
};

/** Field names the site already writes (or looks records up by), and the Beta mark: never a target of an added field. */
const reservedSalesforceFields = (): Set<string> => {
  const out = new Set<string>();
  for (const p of fieldsWritten()) for (const f of [...p.fields, ...(p.optional ?? []), ...(p.lookupField ? [p.lookupField] : [])]) out.add(f.toLowerCase());
  out.add(appConfig.salesforce.betaField.toLowerCase());
  return out;
};

/** GET /admin/security/salesforce/custom-fields — admins: every added field, its link and whether it is sent (fresh describe). */
export const salesforceCustomFields = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const defs = await customFields.allDefinitions();
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { fields: defs.map((d) => ({ ...d, object: salesforceObjectOf(d.form) })), salesforce: await salesforceStatuses(defs, true) } });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** PUT /admin/security/salesforce/custom-fields/:id — admins: body { sfField: '<Name>__c' | null }. Links an added field
 *  to a custom field the owner created in Salesforce (Contact for a sign-up field, the Position Case for a job field).
 *  The site never creates or deletes a field there; nothing is sent until the org has it (checked by describe).
 *  Logged as salesforce.custom_field_linked (field id, object, the API name — never an answer). */
export const linkSalesforceCustomField = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !('sfField' in body)) return res.status(400).json({ message: 'bad_value', code: 'bad_value' });
  const raw = body.sfField;
  const sfField = raw === null || raw === '' ? null : typeof raw === 'string' ? raw.trim() : undefined;
  if (sfField === undefined || (sfField !== null && !SF_FIELD_RE.test(sfField))) return res.status(400).json({ message: 'sf_field_invalid', code: 'sf_field_invalid' });
  try {
    const def = await customFields.findDefinition(String(req.params.id ?? ''));
    if (!def) return res.status(404).json({ message: 'not_found', code: 'not_found' });
    if (sfField) {
      if (reservedSalesforceFields().has(sfField.toLowerCase())) return res.status(400).json({ message: 'sf_field_reserved', code: 'sf_field_reserved' });
      const taken = (await customFields.definitionsOf(def.form)).some((d) => d.id !== def.id && d.sfField?.toLowerCase() === sfField.toLowerCase());
      if (taken) return res.status(409).json({ message: 'sf_field_taken', code: 'sf_field_taken' });
    }
    const field = await customFields.linkSalesforceField(def, sfField, req.authJwtPayload?.userID);
    const s = await salesforceStatuses([field], true);
    void writeAudit(actorOf(req), 'salesforce.custom_field_linked', `custom_field:${def.id}`, {
      form: def.form, object: salesforceObjectOf(def.form), sf_field: sfField, before: def.sfField, status: s.status[def.id],
    });
    res.json({ data: { field: { ...field, object: salesforceObjectOf(field.form) }, salesforce: s } });
  } catch (error) {
    console.error('[settings] salesforce link failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** GET /admin/settings/apply-policy — the site-wide defaults. */
export const getApplyPolicy = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await settingsService.getApplyPolicyDefaults() });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** PUT /admin/settings/apply-policy — body: { guestMode?: 'self'|'quick'|'none', quickCv?: 'required'|'optional',
 *  regularCv?: 'required'|'optional' } (applyPolicy.ts). Logged with the values (settings, not personal data). */
export const updateApplyPolicy = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  const valid = keys.length > 0 && keys.every((k) =>
    (POLICY_FIELDS as readonly string[]).includes(k) && isValidPolicyValue(k as (typeof POLICY_FIELDS)[number], body[k]));
  if (!valid) {
    return next(new AxiosError(GlobalErrorMessages.ILLEGAL_ARGUMENT, GlobalErrorCodes.ILLEGAL_ARGUMENT));
  }
  try {
    const value = await settingsService.updateApplyPolicyDefaults(body as Partial<ApplyPolicy>, req.authJwtPayload?.userID);
    void writeAudit(actorOf(req), 'settings.apply_policy_updated', 'applyPolicy', body);
    res.json({ data: value });
  } catch (error) {
    console.error('[settings] update failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** GET /admin/settings/employer-posting — { mode: 'open' | 'account_required' } (content managers and admins). */
export const getEmployerPosting = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: { mode: await settingsService.getEmployerPosting() } });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** PUT /admin/settings/employer-posting — body { mode }. Logged as settings.employer_posting_updated (a setting
 *  value, not personal data). */
export const updateEmployerPosting = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'mode' || !isEmployerPostingMode(body.mode)) {
    return next(new AxiosError(GlobalErrorMessages.ILLEGAL_ARGUMENT, GlobalErrorCodes.ILLEGAL_ARGUMENT));
  }
  try {
    const before = await settingsService.getEmployerPosting();
    const mode = await settingsService.updateEmployerPosting(body.mode, req.authJwtPayload?.userID);
    void writeAudit(actorOf(req), 'settings.employer_posting_updated', 'employerPosting', { mode, before });
    res.json({ data: { mode } });
  } catch (error) {
    console.error('[settings] update failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** GET /job-submissions/policy — public: whether the employer form needs an account (the mode only). */
export const publicEmployerPosting = async (_req: Request, res: Response) => {
  res.json({ data: { mode: await settingsService.getEmployerPosting() } });
};

/** GET /admin/settings/signup-fields — which candidate sign-up fields are required / optional / hidden (content managers and admins). */
export const getSignupFields = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: { fields: await settingsService.getSignupFields(), modes: modesOf() } });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

const modesOf = () => Object.fromEntries(SIGNUP_FIELDS.map((f) => [f, signupFieldModes(f)]));

/** PUT /admin/settings/signup-fields — body { phoneNumber?, citySymbol?, gender?, dateOfBirth?, idNumber? }, each
 *  'required' | 'optional' (idNumber also 'hidden'). Logged as settings.signup_fields_updated with the setting's
 *  values before and after (a setting, not personal data). */
export const updateSignupFields = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => isSignupFieldMode(k, body[k]))) {
    return next(new AxiosError(GlobalErrorMessages.ILLEGAL_ARGUMENT, GlobalErrorCodes.ILLEGAL_ARGUMENT));
  }
  try {
    const before = await settingsService.getSignupFields();
    const fields = await settingsService.updateSignupFields(body as Partial<SignupFieldsSetting>, req.authJwtPayload?.userID);
    const changed = SIGNUP_FIELDS.filter((f) => before[f] !== fields[f]);
    void writeAudit(actorOf(req), 'settings.signup_fields_updated', 'signupFields', {
      changed, before: Object.fromEntries(changed.map((f) => [f, before[f]])), after: Object.fromEntries(changed.map((f) => [f, fields[f]])),
    });
    res.json({ data: { fields, modes: modesOf() } });
  } catch (error) {
    console.error('[settings] update failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** GET /auth/signup-fields — public: the sign-up form's required / optional / hidden fields (the setting only). */
export const publicSignupFields = async (_req: Request, res: Response) => {
  res.json({ data: { fields: await settingsService.getSignupFields() } });
};

// ---- added fields (models/schemas/customFields.ts, docs/settings.md) --------------------------------------------
// Definitions are settings (content managers and admins); the answers are personal data (sign-up) or job content.
// The log records the field's id, its form and the NAMES of the definition keys that changed — the label and options
// are the staff's own wording, not a candidate's answer, so a new field's label is logged too. Answers never are.

const refuseField = (res: Response, status: number, code: string) => res.status(status).json({ message: code, code });

/** GET /admin/settings/custom-fields — every added field of both forms, active and off (content managers and admins). */
export const listCustomFields = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    const fields = await customFields.allDefinitions();
    // Whether each one reaches Salesforce (cached describe; admins link fields on the security screen).
    res.json({ data: { fields, limits: CUSTOM_FIELD_LIMITS, salesforce: await salesforceStatuses(fields) } });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** POST /admin/settings/custom-fields — body { form: 'signup'|'job', label, type, options?, required?, sortOrder?,
 *  active?, showOnJobPage? (job only), help? }. 400 with a code (customFields.ts checkDefinition), 409 too_many_fields. */
/** Wording of a sign-up question: a content manager's change of these needs an admin's approval again. */
const REWORDING_KEYS = ['label', 'options', 'help'] as const;
/** A content manager tried to turn a sign-up question on (403, logged as access.denied). */
export const ADMIN_APPROVAL_REQUIRED = 'admin_approval_required';
const isAdminCaller = (req: Request) => (req.authUser?.roles ?? []).includes('admin');

export const createCustomField = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  const { form, ...rest } = body;
  if (!isCustomFieldForm(form)) return refuseField(res, 400, 'bad_form');
  if (form === 'signup' && rest.showOnJobPage === true) return refuseField(res, 400, 'bad_value'); // sign-up answers are never public
  const check = checkDefinition(rest);
  if (!check.ok) return refuseField(res, 400, check.error);
  // A sign-up question is asked only after an ADMIN turned it on (owner, 24.11.2026; docs/settings.md "Sign-up questions
  // need an admin"): a content manager's new one is saved OFF, awaiting an admin; an admin's own is approved by them.
  const admin = isAdminCaller(req);
  const pending = form === 'signup' && check.value.active && !admin;
  if (pending) check.value.active = false;
  try {
    const field = await customFields.createDefinition(form, check.value, req.authJwtPayload?.userID,
      form === 'signup' && check.value.active && admin ? actorOf(req) : null);
    void writeAudit(actorOf(req), 'settings.custom_field_created', `custom_field:${field.id}`, {
      form, type: field.type, label: field.label, required: field.required, active: field.active, options: field.options.length,
      ...(form === 'signup' ? { awaiting_admin: pending, approved: field.active } : {}),
    });
    res.status(201).json({ data: { field, ...(pending ? { awaitingAdmin: true } : {}) } });
  } catch (error) {
    if (error instanceof customFields.TooManyFieldsError) return refuseField(res, 409, 'too_many_fields');
    console.error('[settings] custom field create failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** PATCH /admin/settings/custom-fields/:id — any of label, options, required, sortOrder, active, showOnJobPage, help
 *  (the type never changes). Turning a field off is the only "delete": its answers stay. */
export const updateCustomField = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
  if (!Object.keys(body).length) return refuseField(res, 400, 'bad_value');
  try {
    const def = await customFields.findDefinition(String(req.params.id ?? ''));
    if (!def) return refuseField(res, 404, 'not_found');
    if (def.form === 'signup' && body.showOnJobPage === true) return refuseField(res, 400, 'bad_value');
    const { id: _id, form: _form, ...base } = def;
    const check = checkDefinition(body, base);
    if (!check.ok) return refuseField(res, 400, check.error);
    const changed = changedKeys(base, check.value);
    if (!changed.length) return res.json({ data: { field: def } });
    // Sign-up questions (owner, 24.11.2026): only an admin turns one on; a content manager who rewords an active one
    // (label, options, help) turns it off until an admin approves the new wording. An admin's change is approved.
    let approval: Parameters<typeof customFields.updateDefinition>[3] = { kind: 'keep' };
    let awaitingAdmin = false;
    if (def.form === 'signup') {
      const admin = isAdminCaller(req);
      const turningOn = check.value.active && !def.active;
      const reworded = changed.some((k) => (REWORDING_KEYS as readonly string[]).includes(k));
      if (!admin && turningOn) {
        auditDenied(req, ADMIN_APPROVAL_REQUIRED);
        return refuseField(res, 403, ADMIN_APPROVAL_REQUIRED);
      }
      if (!admin && reworded) { check.value.active = false; approval = { kind: 'clear' }; awaitingAdmin = def.active || !def.approvedAt; }
      else if (admin && check.value.active && (turningOn || reworded || !def.approvedAt)) approval = { kind: 'approve', by: actorOf(req) };
    }
    const field = await customFields.updateDefinition(def, check.value, req.authJwtPayload?.userID, approval);
    const finalChanged = changedKeys(base, check.value);
    void writeAudit(actorOf(req), 'settings.custom_field_updated', `custom_field:${def.id}`, {
      form: def.form, changed: finalChanged,
      ...(finalChanged.includes('label') ? { label: field.label } : {}),
      ...(finalChanged.includes('active') ? { active: field.active } : {}),
      ...(finalChanged.includes('required') ? { required: field.required } : {}),
      ...(awaitingAdmin ? { awaiting_admin: true } : {}),
    });
    if (approval.kind === 'approve') void writeAudit(actorOf(req), 'settings.custom_field_approved', `custom_field:${def.id}`, { form: def.form, label: field.label });
    res.json({ data: { field, ...(awaitingAdmin ? { awaitingAdmin: true } : {}) } });
  } catch (error) {
    console.error('[settings] custom field update failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** GET /custom-fields/signup — public: the sign-up form's added questions (active only; the setting, no answers). */
export const publicSignupCustomFields = async (_req: Request, res: Response) => {
  res.json({ data: { fields: formFields(await customFields.definitionsOf('signup')) } });
};

/** GET /custom-fields/job — public: the job form's added fields for the employer form (/post-job, edit requests):
 *  active definitions only (label, type, options, required, hint), never an answer or a staff flag. */
export const publicJobCustomFields = async (_req: Request, res: Response) => {
  const defs = await customFields.definitionsOf('job');
  const onPage = new Set(defs.filter((d) => d.showOnJobPage).map((d) => d.id));
  // showOnJobPage: public by nature (the job page shows those); an employer's edit request covers only those.
  res.json({ data: { fields: formFields(defs).map((f) => ({ ...f, showOnJobPage: onPage.has(f.id) })) } });
};

/** GET /admin/job-fields — the job form's added fields (active only) for everyone who edits jobs (coordinators too). */
export const jobFormFields = async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ data: { fields: (await customFields.definitionsOf('job')).filter((d) => d.active)
    .sort((a, b) => a.sortOrder - b.sortOrder) } });
};
