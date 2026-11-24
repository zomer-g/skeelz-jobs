import { isCandidate, isEmployer, STAFF_ROLES } from '../models/enums.js';
// Fields content managers add to the sign-up form and the job form (models/schemas/customFields.ts, docs/settings.md).
// One process, so the definitions are held in memory and refreshed on every write and at least every minute; reads that
// can't wait (rowToJob, which is synchronous) use the last loaded copy and fail CLOSED: with nothing loaded, no added
// value is shown on a public page.
import { query, queryOne } from '../config/db.js';
import { newObjectId } from '../utils/ids.js';
import { jobsChanged } from './jobsCache.js';
import {
  checkCustomValues, CustomFieldDef, CustomFieldForm, CustomValue, CUSTOM_FIELD_LIMITS, DefinitionCheck, mergeCustomValues,
  missingRequired, shownValues, ShownValue, ValuesCheck,
} from '../models/schemas/customFields.js';

const CACHE_MS = 60_000;
let cache: { defs: CustomFieldDef[]; at: number } | null = null;

const rowToDef = (r: any): CustomFieldDef => ({
  id: r.id, form: r.form, label: r.label, type: r.type, options: Array.isArray(r.options) ? r.options.map(String) : [],
  required: !!r.required, sortOrder: Number(r.sort_order) || 0, active: !!r.active, showOnJobPage: !!r.show_on_job_page,
  help: r.help ?? '', sfField: r.sf_field ?? null,
  approvedAt: r.approved_at ?? null,
});

const load = async (): Promise<CustomFieldDef[]> => {
  const rows = await query(`SELECT * FROM custom_fields ORDER BY form, sort_order, created_at`);
  const defs = rows.map(rowToDef);
  cache = { defs, at: Date.now() };
  return defs;
};

/** Every definition (active and off), both forms. Fails to the last known copy, else none (the forms then show no
 *  added field and the server accepts none: nothing new is collected while the table can't be read). */
export const allDefinitions = async (): Promise<CustomFieldDef[]> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.defs;
  try {
    return await load();
  } catch (error) {
    console.error('[custom-fields] read failed', (error as Error).message);
    return cache?.defs ?? [];
  }
};

export const definitionsOf = async (form: CustomFieldForm): Promise<CustomFieldDef[]> =>
  (await allDefinitions()).filter((d) => d.form === form);

/** The job form's added fields an employer-facing caller may see and fill (security review 24.11.2026, L5): every one
 *  for a signed-in employer or staff member (owner, 24.11.2026: employers edit every field, staff-only ones write-only);
 *  for anyone else (the anonymous employer form) only the ones the job page shows. */
export const employerFacing = (defs: CustomFieldDef[], caller: { roles?: readonly string[] | null; role?: string | null } | null | undefined): CustomFieldDef[] =>
  caller && (isEmployer(caller) || (caller.roles?.length ? caller.roles : [caller.role]).some((r) => STAFF_ROLES.includes(r as any)))
    ? defs : defs.filter((d) => d.showOnJobPage);

/** The last loaded copy (synchronous; may be a minute old). Starts a refresh when it is stale. */
export const cachedDefinitions = (form: CustomFieldForm): CustomFieldDef[] => {
  if (!cache || Date.now() - cache.at >= CACHE_MS) void allDefinitions();
  return (cache?.defs ?? []).filter((d) => d.form === form);
};

export const findDefinition = async (id: string): Promise<CustomFieldDef | null> => {
  const r = await queryOne(`SELECT * FROM custom_fields WHERE id = $1`, [String(id)]);
  return r ? rowToDef(r) : null;
};

export class TooManyFieldsError extends Error {}

/** approvedBy: the admin who turned a sign-up question on (null = not approved; job fields need none). */
export const createDefinition = async (form: CustomFieldForm, value: Extract<DefinitionCheck, { ok: true }>['value'], by: string | undefined,
  approvedBy: string | null = null): Promise<CustomFieldDef> => {
  const count = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM custom_fields WHERE form = $1`, [form]);
  if (Number(count?.n ?? 0) >= CUSTOM_FIELD_LIMITS.perForm) throw new TooManyFieldsError();
  // A new field goes last unless an order was given.
  let order = value.sortOrder;
  if (!order) {
    const max = await queryOne<{ m: number | null }>(`SELECT MAX(sort_order) AS m FROM custom_fields WHERE form = $1`, [form]);
    order = (Number(max?.m) || 0) + 10;
  }
  const id = newObjectId();
  const r = await queryOne(
    `INSERT INTO custom_fields (id, form, label, type, options, required, sort_order, active, show_on_job_page, help, created_by, updated_by,
                                approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$11,$12, CASE WHEN $12::text IS NULL THEN NULL ELSE now() END) RETURNING *`,
    [id, form, value.label, value.type, JSON.stringify(value.options), value.required, order, value.active,
      form === 'job' && value.showOnJobPage, value.help, by ?? null, approvedBy]);
  await load();
  jobsChanged(); // the job page shows the labels of the job fields
  return rowToDef(r);
};

/** approval: 'approve' (an admin, by) / 'clear' (reworded by a content manager: off until approved) / 'keep'. */
export const updateDefinition = async (def: CustomFieldDef, value: Extract<DefinitionCheck, { ok: true }>['value'], by: string | undefined,
  approval: { kind: 'approve'; by: string } | { kind: 'clear' } | { kind: 'keep' } = { kind: 'keep' }): Promise<CustomFieldDef> => {
  const r = await queryOne(
    `UPDATE custom_fields SET label = $2, options = $3::jsonb, required = $4, sort_order = $5, active = $6, show_on_job_page = $7,
       help = $8, updated_by = $9, updated_at = now(),
       approved_by = CASE $10 WHEN 'approve' THEN $11 WHEN 'clear' THEN NULL ELSE approved_by END,
       approved_at = CASE $10 WHEN 'approve' THEN now() WHEN 'clear' THEN NULL ELSE approved_at END
     WHERE id = $1 RETURNING *`,
    [def.id, value.label, JSON.stringify(value.options), value.required, value.sortOrder, value.active,
      def.form === 'job' && value.showOnJobPage, value.help, by ?? null, approval.kind, approval.kind === 'approve' ? approval.by : null]);
  await load();
  jobsChanged(); // the job page shows the labels of the job fields
  return rowToDef(r);
};

// ---- answers ------------------------------------------------------------------------------------------------
export const checkValues = async (form: CustomFieldForm, raw: unknown, opts: { requireAll?: boolean } = {}): Promise<ValuesCheck> =>
  checkCustomValues(await definitionsOf(form), raw, opts);

/** Stores a candidate's answers (merged into the stored ones; null removes one). Candidates only. */
export const saveUserValues = async (userId: string, patch: Record<string, CustomValue | null>): Promise<void> => {
  if (!Object.keys(patch).length) return;
  const cur = await queryOne<{ custom_fields: unknown }>(`SELECT custom_fields FROM users WHERE id = $1 AND 'user' = ANY(roles)`, [userId]);
  if (!cur) return;
  await query(`UPDATE users SET custom_fields = $2::jsonb, updated_at = now() WHERE id = $1 AND 'user' = ANY(roles)`,
    [userId, JSON.stringify(mergeCustomValues(cur.custom_fields, patch))]);
};

export const userValues = async (userId: string): Promise<Record<string, CustomValue>> => {
  const r = await queryOne<{ custom_fields: Record<string, CustomValue> }>(`SELECT custom_fields FROM users WHERE id = $1`, [userId]);
  return mergeCustomValues(r?.custom_fields ?? {}, {});
};

/** A candidate who has not answered an active required added field (asked to complete their details). */
export const userMissingRequired = async (user: { id?: unknown; _id?: unknown; role?: string | null; roles?: readonly string[] | null } | null | undefined): Promise<boolean> => {
  // Several roles per account: a candidate who is also an employer / staff is still asked (security review 24.11, M1).
  if (!user || !isCandidate(user)) return false;
  const defs = await definitionsOf('signup');
  if (!defs.some((d) => d.active && d.required)) return false;
  return missingRequired(defs, await userValues(String(user.id ?? user._id))).length > 0;
};

/** Stores a job's answers (merged; null removes one). Jobs of the existing site are refused before this (assertJobEditable). */
export const saveJobValues = async (jobId: string, patch: Record<string, CustomValue | null>): Promise<void> => {
  if (!Object.keys(patch).length) return;
  const cur = await queryOne<{ custom_fields: unknown }>(`SELECT custom_fields FROM jobs WHERE id = $1`, [jobId]);
  if (!cur) return;
  await query(`UPDATE jobs SET custom_fields = $2::jsonb, updated_at = now() WHERE id = $1`, [jobId, JSON.stringify(mergeCustomValues(cur.custom_fields, patch))]);
  jobsChanged();
};

/** The staff candidates list: each candidate's answers with their labels (through peopleHandover, like the rest). */
export const shownUserValues = (stored: unknown): ShownValue[] => shownValues(cachedDefinitions('signup'), stored);

/** Links an added field to a Salesforce field (admins; null unlinks). The name was checked by the caller. */
export const linkSalesforceField = async (def: CustomFieldDef, sfField: string | null, by: string | undefined): Promise<CustomFieldDef> => {
  const r = await queryOne(`UPDATE custom_fields SET sf_field = $2, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [def.id, sfField, by ?? null]);
  await load();
  return rowToDef(r);
};

/** The job form's answers of a stored employer submission. */
export const submissionValues = async (submissionId: string): Promise<Record<string, CustomValue>> => {
  const r = await queryOne<{ custom_fields: unknown }>(`SELECT custom_fields FROM job_submissions WHERE id = $1`, [submissionId]);
  return mergeCustomValues(r?.custom_fields ?? {}, {});
};
export const saveSubmissionValues = async (submissionId: string, patch: Record<string, CustomValue | null>): Promise<void> => {
  if (!Object.keys(patch).length) return;
  const cur = await submissionValues(submissionId);
  await query(`UPDATE job_submissions SET custom_fields = $2::jsonb, updated_at = now() WHERE id = $1 AND status = 'pending'`,
    [submissionId, JSON.stringify(mergeCustomValues(cur, patch))]);
};
export const jobValues = async (jobId: string): Promise<Record<string, CustomValue>> => {
  const r = await queryOne<{ custom_fields: unknown }>(`SELECT custom_fields FROM jobs WHERE id = $1`, [jobId]);
  return mergeCustomValues(r?.custom_fields ?? {}, {});
};
