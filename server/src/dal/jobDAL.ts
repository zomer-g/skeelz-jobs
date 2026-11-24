import { AxiosError } from "axios";
import { CreateJobDTO } from "../dto/createJobDto.js";
import { Job } from "../models/schemas/jobs.js";
import { JobsErrorCodes, JobsErrorMessages } from "../i18n/i18n.js";
import { filterOptions } from "../models/interfaces/general.interface.js";
import { UpdateJobDto } from "../dto/updateJobDto.js";
import { CustomCitySymbol, DayValues } from "../models/enums.js";
import { escapeLike, escapeRegex, query, queryOne } from "../config/db.js";
import { isObjectId, newObjectId } from "../utils/ids.js";
import { sanitizeJobHtml } from "../utils/sanitize.js";
import { ApplyPolicy, ApplyPolicyOverrides, GuestMode, isValidOverride, resolveApplyPolicy, showsEmployerContact } from "../models/schemas/applyPolicy.js";
import { getApplyPolicyDefaults } from "../services/settingsService.js";
import { MANAGED_FIELDS, PUBLIC_LISTING_SQL, PUBLIC_ORDER_SQL, stripManagedFields } from "../models/schemas/jobBoard.js";
import { JobReadOnlyError } from "../middleware/errorMiddleware.js";
import { checkThresholdCondition, thresholdConditionOf } from "../models/schemas/thresholdCondition.js";
import { asCustomValues, shownValues } from "../models/schemas/customFields.js";
import { cachedDefinitions } from "../services/customFieldsService.js";

const ALWAYS_MATCH_LOCATIONS = [CustomCitySymbol.WorkFromAnyPlace, CustomCitySymbol.WorkFromHome];

// Only these fields can be sorted on (any other name is ignored).
const SORT_COLUMNS: Record<string, string> = {
  publishDate: 'j.publish_date',
  updatedAt: 'j.updated_at',
  createdAt: 'j.created_at',
  title: 'j.title',
  companyName: 'j.company_name',
  status: 'j.status',
  jobId: 'j.job_id',
  location: 'l.city',
  pinnedAt: 'j.pinned_at',
  bumpedAt: 'j.bumped_at',
  isSponsored: 'j.is_sponsored',
};

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined || v === null || (v as any) === '' ? [] : Array.isArray(v) ? v : [v];

const toNumbers = (v: any): number[] => asArray(v).map(Number).filter(Number.isFinite);
const toStrings = (v: any): string[] => asArray(v).map(String).filter(Boolean);

export const dateToDisplay = (publishDate?: Date | string | null): string => {
  if (!publishDate) return '';
  const inputDate = new Date(publishDate);
  const now = new Date();
  const values = [DayValues.TODAY, DayValues.ONE, DayValues.TWO, DayValues.THREE, DayValues.FOUR, DayValues.FIVE, DayValues.SIX, DayValues.SEVEN];
  for (let n = 0; n <= 7; n++) {
    const t = new Date(now);
    t.setUTCDate(now.getUTCDate() - n);
    if (t.getUTCFullYear() === inputDate.getUTCFullYear() && t.getUTCMonth() === inputDate.getUTCMonth() && t.getUTCDate() === inputDate.getUTCDate()) {
      return values[n];
    }
  }
  const day = inputDate.getUTCDate().toString().padStart(2, '0');
  const month = (inputDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = inputDate.getUTCFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
};

const JOB_SELECT = `
  j.*, l.city AS l_city, l.district AS l_district, l.city_symbol AS l_city_symbol,
  COALESCE((SELECT jsonb_object_agg(s.id, s.name) FROM skills s WHERE s.id = ANY(j.required_skills)), '{}'::jsonb) AS skills_map
`;

const rowOverrides = (r: any): ApplyPolicyOverrides => ({
  guestModeOverride: r.guest_mode_override ?? null,
  quickCvOverride: r.quick_cv_override ?? null,
  regularCvOverride: r.regular_cv_override ?? null,
});

/** DB row -> the job shape the client already understands. */
/** withComments: staff (comments, overrides, contacts, uploadBy). withContacts: one job, or the public v1 API / MCP —
 *  the employer's contact goes out only on a self-apply job. Lists for the site (board, map, page data) never carry
 *  contacts: the self-apply view fetches them from GET /api/jobs/:jobId. */
type RowOpts = { withComments?: boolean; withContacts?: boolean; applyDefaults?: ApplyPolicy };

export const rowToJob = (r: any, opts: RowOpts = {}): Job => {
  const job: Job = {
    _id: r.id,
    id: r.id,
    title: r.title,
    jobScope: r.job_scope ?? [],
    companyName: r.company_name,
    publishDate: r.publish_date,
    citySymbol: r.city_symbol,
    description: r.description,
    jobId: r.job_id,
    contactPersonName: r.contact_person_name ?? undefined,
    contactPersonPhone: r.contact_person_phone ?? undefined,
    contactPersonEmail: r.contact_person_email ?? undefined,
    externalLink: r.external_link ?? undefined,
    // תנאי סף: public (the candidate confirms it before applying). Plain text, never HTML.
    thresholdCondition: thresholdConditionOf(r.threshold_condition),
    uploadBy: r.upload_by ?? undefined,
    status: r.status,
    requiredSkills: r.required_skills ?? [],
    requiredSkillsDetails: r.skills_map ?? {},
    isSponsored: r.is_sponsored,
    isMarked: r.is_marked,
    isSelfApply: !!r.is_self_apply,
    // A job of the existing site (imported, or mirrored while that site manages it): shown, but applications to it
    // are not taken here (jobApplicationService; db.ts job_applications_legacy_guard).
    onExistingSite: !!r.imported_from_live || r.legacy_state === 'mirror',
    pinnedAt: r.pinned_at ?? null,
    bumpedAt: r.bumped_at ?? null,
    dateToDisplay: dateToDisplay(r.publish_date),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.l_city !== undefined && r.l_city !== null) {
    job.location = { _id: String(r.l_city_symbol), city: r.l_city, district: r.l_district };
  }
  if (opts.withComments) {
    job.comments = r.comments ?? undefined;
    job.guestModeOverride = r.guest_mode_override ?? null;
    job.quickCvOverride = r.quick_cv_override ?? null;
    job.regularCvOverride = r.regular_cv_override ?? null;
    job.deletedBy = r.deleted_by ?? null;
    job.managedFields = r.managed_fields ?? [];
    // Read-only here: the local seed of the existing site's jobs, or one of its jobs still managed there (mirror).
    job.importedFromLive = !!r.imported_from_live || r.legacy_state === 'mirror';
    job.legacyState = r.legacy_state ?? null;
    job.legacySfId = r.legacy_sf_id ?? null;
  }
  if (r.deleted_at !== undefined) job.deletedAt = r.deleted_at ?? null;
  // Added job fields (settings screen): staff get every answer by field id (the job form); everyone gets the answers of
  // active fields marked "show on the job page", with their labels. Never in the public API / MCP (toPublicJob) or Salesforce.
  if (opts.withComments) (job as any).customFields = asCustomValues(r.custom_fields);
  const shown = shownValues(cachedDefinitions('job'), r.custom_fields, { onlyJobPage: true });
  if (shown.length) (job as any).extraFields = shown.map(({ label, value }) => ({ label, value }));
  if (opts.applyDefaults) {
    job.applyPolicy = resolveApplyPolicy(rowOverrides(r), opts.applyDefaults);
    job.isSelfApply = job.applyPolicy.guestMode === 'self';
  }
  // The employer's contact details reach the public only on a self-apply job (applyPolicy.showsEmployerContact), and
  // only where one job is asked for (withContacts). Staff (withComments) always see them; without a policy (no
  // defaults passed) they are never sent. uploadBy (a staff email) is for staff only.
  if (!opts.withComments && !(opts.withContacts && job.applyPolicy && showsEmployerContact(job.applyPolicy))) {
    delete job.contactPersonName;
    delete job.contactPersonPhone;
    delete job.contactPersonEmail;
  }
  if (!opts.withComments) delete job.uploadBy;
  return job;
};

/** Builds the WHERE clause for the public/admin job lists. */
const buildFilter = (f: filterOptions = {}, params: any[]) => {
  const where: string[] = [];
  const p = (v: any) => { params.push(v); return `$${params.length}`; };

  const cities = toNumbers(f.jobCitySymbol);
  const districts = toStrings(f.jobDistricts);

  if (cities.length && !districts.length) {
    where.push(`j.city_symbol = ANY(${p([...cities, ...ALWAYS_MATCH_LOCATIONS])}::int[])`);
  }
  if (districts.length) {
    where.push(`(l.district = ANY(${p(districts)}::text[]) OR j.city_symbol = ANY(${p([...cities, ...ALWAYS_MATCH_LOCATIONS])}::int[]))`);
  }
  const scopes = toStrings(f.jobScopeIds);
  if (scopes.length) where.push(`j.job_scope && ${p(scopes)}::text[]`);
  const statuses = toStrings(f.jobStatus);
  if (statuses.length) where.push(`j.status = ANY(${p(statuses)}::text[])`);
  if (String(f.isSponsored) === 'true') where.push(`j.is_sponsored = true`);
  const skills = toStrings(f.jobSkillsIds).filter(isObjectId);
  if (skills.length) where.push(`j.required_skills && ${p(skills)}::text[]`);

  const input = typeof f.inputValue === 'string' ? f.inputValue.trim() : '';
  if (input) {
    // Same matching as before: the title matches the typed letters in order
    // (fuzzy), the description and company name match the text as a substring.
    const letters = input.toLowerCase().replace(/[\s\-?!/@+*)(.:"',]/g, '').split('');
    const like = `%${escapeLike(input)}%`;
    const ors = [`j.description ILIKE ${p(like)}`, `j.company_name ILIKE ${p(like)}`];
    if (letters.length) ors.unshift(`j.title ~* ${p(letters.map(escapeRegex).join('.*'))}`);
    where.push(`(${ors.join(' OR ')})`);
  }
  return where;
};

/** Jobs-management filters (staff list only). Archived jobs are left out unless asked for. */
const buildBoardFilter = (f: filterOptions = {}) => {
  const where: string[] = [];
  if (String(f.pinned) === 'true') where.push(`j.pinned_at IS NOT NULL`);
  if (String(f.scheduled) === 'true') where.push(`j.publish_date > now()`);
  if (f.archived === 'only') where.push(`j.deleted_at IS NOT NULL`);
  else if (f.archived !== 'include') where.push(`j.deleted_at IS NULL`);
  return where;
};

/** Staff lists may sort by a column; otherwise (and always for public lists) the public order. */
const orderBy = (f: filterOptions = {}) => {
  const col = f.sortField ? SORT_COLUMNS[f.sortField] : undefined;
  if (col && f.sortOrder) {
    const dir = String(f.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    return `${col} ${dir} ${dir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST'}, j.id DESC`;
  }
  return PUBLIC_ORDER_SQL('j');
};

export const findJobs = async (
  filterParams: filterOptions = {},
  extraWhere: string[] = [],
  opts: { withComments?: boolean; withContacts?: boolean; excludeIds?: string[] } = {}
): Promise<{ jobs: Job[]; total: number }> => {
  try {
    const page = Math.max(1, Number(filterParams?.page) || 1);
    const limit = Math.min(1000, Math.max(1, Number(filterParams?.limit) || 1000));
    const params: any[] = [];
    const where = [...buildFilter(filterParams, params), ...extraWhere];
    const exclude = (opts.excludeIds ?? []).filter(isObjectId);
    if (exclude.length) {
      params.push(exclude);
      where.push(`NOT (j.id = ANY($${params.length}::text[]))`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM jobs j JOIN locations l ON l.city_symbol = j.city_symbol ${whereSql}`;

    const [rows, count, applyDefaults] = await Promise.all([
      query(`SELECT ${JOB_SELECT} ${from} ORDER BY ${orderBy(filterParams)} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
      queryOne<{ count: string }>(`SELECT COUNT(*)::int AS count ${from}`, params),
      getApplyPolicyDefaults(),
    ]);
    return { jobs: rows.map((r) => rowToJob(r, { ...opts, applyDefaults })), total: Number(count?.count ?? 0) };
  } catch (error) {
    console.error('[jobs] find failed', (error as Error).message);
    throw new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED);
  }
};

export const findAllJobs = async (filterParams?: filterOptions) =>
  findJobs(filterParams, buildBoardFilter(filterParams), { withComments: true });

/** The public board: listed jobs only, always in the public order (a sort from the request is ignored). No internal
 *  comments, no employer contact details (not even on self-apply jobs: the job page fetches those from
 *  GET /api/jobs/:jobId) and no uploadBy. */
export const findActiveJobsWithoutComments = async (filterParams?: filterOptions, excludeIds: string[] = []) =>
  findJobs({ ...filterParams, sortField: undefined, sortOrder: undefined }, [PUBLIC_LISTING_SQL('j')], { excludeIds });

export const getRandomSponsoredJobs = async (limit: number = 2, filterParams?: filterOptions): Promise<Job[]> => {
  try {
    const params: any[] = [];
    const where = [...buildFilter({ ...filterParams, isSponsored: undefined, jobStatus: undefined }, params), `j.is_marked = true`, PUBLIC_LISTING_SQL('j'), `j.pinned_at IS NULL`];
    const rows = await query(
      `SELECT ${JOB_SELECT} FROM jobs j JOIN locations l ON l.city_symbol = j.city_symbol
       WHERE ${where.join(' AND ')} ORDER BY random() LIMIT ${Math.max(1, Math.min(10, limit))}`,
      params
    );
    const applyDefaults = await getApplyPolicyDefaults();
    return rows.map((r) => rowToJob(r, { applyDefaults }));
  } catch (error) {
    console.error('[jobs] sponsored failed', (error as Error).message);
    throw new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED);
  }
};

/** Full job by its public id. Comments only when asked (staff); the employer's contact on a self-apply job, or to staff. */
export const findJobByJobId = async (jobId: string, opts: { withComments?: boolean } = {}): Promise<Job | null> => {
  if (!isObjectId(jobId)) return null;
  try {
    const row = await queryOne(
      `SELECT ${JOB_SELECT} FROM jobs j LEFT JOIN locations l ON l.city_symbol = j.city_symbol WHERE j.id = $1`,
      [jobId]
    );
    return row ? rowToJob(row, { ...opts, withContacts: true, applyDefaults: await getApplyPolicyDefaults() }) : null;
  } catch (error) {
    console.error('[jobs] find by id failed', (error as Error).message);
    throw new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED);
  }
};

/** Old numeric job number (used in Salesforce links) -> public id. */
export const findPublicIdByJobNumber = async (jobNumber: number): Promise<string | null> => {
  const row = await queryOne<{ id: string }>(`SELECT id FROM jobs WHERE job_id = $1`, [jobNumber]);
  return row?.id ?? null;
};

// Writable columns, DTO field -> column.
const COLUMNS: Record<string, string> = {
  title: 'title',
  jobScope: 'job_scope',
  companyName: 'company_name',
  publishDate: 'publish_date',
  citySymbol: 'city_symbol',
  description: 'description',
  contactPersonName: 'contact_person_name',
  contactPersonPhone: 'contact_person_phone',
  contactPersonEmail: 'contact_person_email',
  externalLink: 'external_link',
  uploadBy: 'upload_by',
  status: 'status',
  comments: 'comments',
  requiredSkills: 'required_skills',
  isSponsored: 'is_sponsored',
  isMarked: 'is_marked',
  guestModeOverride: 'guest_mode_override',
  quickCvOverride: 'quick_cv_override',
  regularCvOverride: 'regular_cv_override',
  thresholdCondition: 'threshold_condition',
};

/**
 * The legacy input isSelfApply (old clients, the employer form, integrations) is mapped onto guestModeOverride:
 * true -> 'self'; false -> back to the default, but only if the job was self-apply (it never undoes 'none'/'quick').
 * An explicit guestModeOverride wins. Returns the override to write, or undefined to leave it as it is.
 */
const guestOverrideFrom = (dto: any, current: GuestMode | null | undefined): GuestMode | null | undefined => {
  if (dto.guestModeOverride !== undefined) return dto.guestModeOverride;
  if (dto.isSelfApply === true) return 'self';
  if (dto.isSelfApply === false && current === 'self') return null;
  return undefined;
};

const normalizeValue = (field: string, value: any) => {
  if (field === 'description' || field === 'comments') return value == null ? value : sanitizeJobHtml(String(value));
  if (field === 'jobScope') return Array.from(new Set(asArray(value).map(String)));
  if (field === 'requiredSkills') return asArray(value).map(String).filter(isObjectId);
  if (field === 'guestModeOverride' || field === 'quickCvOverride' || field === 'regularCvOverride') {
    return isValidOverride(field, value) ? value : null;
  }
  // Plain text (thresholdCondition.ts); the DTO caps the length, '' or only tags → no condition.
  if (field === 'thresholdCondition') { const c = checkThresholdCondition(value); return c.ok ? c.value : null; }
  if (field === 'publishDate') return value == null ? value : new Date(typeof value === 'number' ? value : String(value));
  return value;
};

export const createJob = async (dto: CreateJobDTO & { _id?: string; jobId?: number }, source: 'screen' | 'integration' = 'screen'): Promise<Job> => {
  try {
    const id = dto._id && isObjectId(dto._id) ? dto._id : newObjectId();
    const cols = ['id'];
    const vals: any[] = [id];
    const input: any = { ...dto, guestModeOverride: guestOverrideFrom(dto, null) };
    const defaults = await getApplyPolicyDefaults();
    // is_self_apply = the effective guest mode is 'self' (Salesforce isSelfApply_cambium__c).
    cols.push('is_self_apply');
    vals.push(resolveApplyPolicy({ guestModeOverride: input.guestModeOverride ?? null }, defaults).guestMode === 'self');
    for (const [field, col] of Object.entries(COLUMNS)) {
      const v = input[field];
      if (v === undefined) continue;
      cols.push(col);
      vals.push(normalizeValue(field, v));
    }
    if (dto.jobId && Number.isFinite(Number(dto.jobId))) {
      cols.push('job_id');
      vals.push(Number(dto.jobId));
    }
    // Created on the staff screen: its board fields are the screen's (integrations won't overwrite them).
    const managed = source === 'screen' ? (MANAGED_FIELDS as readonly string[]).filter((f) => (dto as any)[f] !== undefined) : [];
    if (managed.length) {
      cols.push('managed_fields');
      vals.push(managed);
    }
    await query(
      `INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals
    );
    return (await findJobByJobId(id, { withComments: true }))!;
  } catch (error) {
    console.error('[jobs] create failed', (error as Error).message);
    throw new AxiosError(JobsErrorMessages.CREATE_JOB_FAILED, JobsErrorCodes.CREATE_JOB_FAILED);
  }
};

export type UpdateSource = 'screen' | 'integration';

/** Jobs imported from the existing site, and its jobs mirrored from Salesforce until the cutover, are read-only here
 *  (db.ts jobs_imported_readonly, jobs_legacy_guard): every write path calls
 *  this first, so the caller gets a clear 409 job_read_only instead of the trigger's error. */
export const assertJobEditable = async (jobId: string): Promise<void> => {
  const r = await queryOne<{ imported_from_live: boolean; legacy_state: string | null }>(
    `SELECT imported_from_live, legacy_state FROM jobs WHERE id = $1`, [jobId]);
  // A job of the existing site is read-only while that site still manages it (legacy_state 'mirror', db.ts jobs_legacy_guard).
  if (r?.imported_from_live || r?.legacy_state === 'mirror') throw new JobReadOnlyError();
};

/**
 * Updates a job. source 'screen' (the staff jobs-management screen and form) records the board fields it
 * sets in managed_fields; source 'integration' (internal API, Salesforce flows) never overwrites those, nor
 * pin / bump / archive (jobBoard.stripManagedFields). `ignored` lists the dropped field names.
 */
export const updateJobById = async (jobId: string, input: UpdateJobDto, source: UpdateSource = 'screen'): Promise<Job | null> => {
  const r = await updateJobByIdDetailed(jobId, input, source);
  return r?.job ?? null;
};

export const updateJobByIdDetailed = async (
  jobId: string, input: UpdateJobDto, source: UpdateSource = 'screen'
): Promise<{ job: Job | null; ignored: string[] } | null> => {
  if (!isObjectId(jobId)) return null;
  await assertJobEditable(jobId);
  let dto: UpdateJobDto = input;
  let ignored: string[] = [];
  if (source === 'integration') {
    const cur = await queryOne<{ managed_fields: string[] }>(`SELECT managed_fields FROM jobs WHERE id = $1`, [jobId]);
    if (!cur) return null;
    const stripped = stripManagedFields(input as Record<string, any>, cur.managed_fields);
    dto = stripped.dto as UpdateJobDto;
    ignored = stripped.ignored;
  }
  const sets: string[] = [];
  const vals: any[] = [];
  const w: any = { ...dto };
  if (w.guestModeOverride !== undefined || typeof w.isSelfApply === 'boolean') {
    const cur = await queryOne<{ guest_mode_override: GuestMode | null }>(`SELECT guest_mode_override FROM jobs WHERE id = $1`, [jobId]);
    if (!cur) return null;
    w.guestModeOverride = guestOverrideFrom(w, cur.guest_mode_override);
    if (w.guestModeOverride !== undefined) {
      const override = normalizeValue('guestModeOverride', w.guestModeOverride);
      const eff = resolveApplyPolicy({ guestModeOverride: override }, await getApplyPolicyDefaults()).guestMode;
      vals.push(eff === 'self');
      sets.push(`is_self_apply = $${vals.length}`);
    }
  }
  for (const [field, col] of Object.entries(COLUMNS)) {
    const v = w[field];
    if (v === undefined) continue;
    vals.push(normalizeValue(field, v));
    sets.push(`${col} = $${vals.length}`);
  }
  if (source === 'screen') {
    const managed = (MANAGED_FIELDS as readonly string[]).filter((f) => (dto as any)[f] !== undefined);
    if (managed.length) {
      vals.push(managed);
      sets.push(`managed_fields = ARRAY(SELECT DISTINCT unnest(managed_fields || $${vals.length}::text[]))`);
    }
  }
  if (sets.length) {
    vals.push(jobId);
    const res = await query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING id`, vals);
    if (!res.length) return null;
  }
  const job = await findJobByJobId(jobId, { withComments: true });
  return job ? { job, ignored } : null;
};

/** Pin (נעץ): stays at the start of every public list until unpinned. Pinning a pinned job changes nothing
 *  (use bump to move it above the other pins). Unpin: back to the normal order (by listing time). */
export const setPinned = async (jobId: string, pinned: boolean): Promise<Job | null> => {
  if (!isObjectId(jobId)) return null;
  await assertJobEditable(jobId);
  const res = await query(
    `UPDATE jobs SET pinned_at = ${pinned ? 'COALESCE(pinned_at, now())' : 'NULL'}, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [jobId]
  );
  return res.length ? findJobByJobId(jobId, { withComments: true }) : null;
};

/** Bump (הקפצה): once to the top of the unpinned jobs (listed as if published now; newer jobs go above it
 *  later). On a pinned job it only moves it to the top of the pinned jobs (bumped_at untouched, so an unpin
 *  later puts it back at its own place). */
export const bumpJob = async (jobId: string): Promise<Job | null> => {
  if (!isObjectId(jobId)) return null;
  await assertJobEditable(jobId);
  const res = await query(
    `UPDATE jobs SET bumped_at = CASE WHEN pinned_at IS NULL THEN now() ELSE bumped_at END,
                     pinned_at = CASE WHEN pinned_at IS NULL THEN NULL ELSE now() END, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [jobId]
  );
  return res.length ? findJobByJobId(jobId, { withComments: true }) : null;
};

/** Soft delete (archive) / restore. Status and sponsored are kept, so a restore brings the
 *  job back as it was, except the pin, which an archive clears. Applications are never touched. */
export const setArchived = async (jobId: string, archived: boolean, by: string): Promise<Job | null> => {
  if (!isObjectId(jobId)) return null;
  await assertJobEditable(jobId);
  const res = archived
    ? await query(`UPDATE jobs SET deleted_at = now(), deleted_by = $2, pinned_at = NULL, updated_at = now()
                   WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [jobId, by])
    : await query(`UPDATE jobs SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
                   WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`, [jobId]);
  return res.length ? findJobByJobId(jobId, { withComments: true }) : null;
};

/** How many applications a job has (the delete dialog says they are kept). */
export const countApplications = async (jobId: string): Promise<number> => {
  if (!isObjectId(jobId)) return 0;
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_applications WHERE job_id = $1`, [jobId]);
  return Number(row?.n ?? 0);
};

export interface NearbyJobsResult {
  jobs: (Job & { distanceKm: number })[];
  total: number;
  /** Active jobs (matching the other filters) whose location has no coordinates. */
  withoutCoordinates: number;
  /** Active remote / nationwide jobs (no place on the map). */
  remote: number;
}

const EARTH_RADIUS_KM = 6371;

/**
 * Listed jobs (PUBLIC_LISTING_SQL) within radiusKm of (lat, lng): pinned first (latest pin on top), then nearest (haversine on the
 * location's settlement point). The other list filters (text, scope, skills)
 * still apply; city/district filters are replaced by the radius.
 */
export const findActiveJobsNear = async (
  lat: number, lng: number, radiusKm: number, filterParams: filterOptions = {}, opts: { withContacts?: boolean } = {}
): Promise<NearbyJobsResult> => {
  try {
    const params: any[] = [];
    const base = [
      ...buildFilter({ ...filterParams, jobCitySymbol: undefined, jobDistricts: undefined, jobStatus: undefined, isSponsored: undefined }, params),
      PUBLIC_LISTING_SQL('j'),
    ];
    const p = (v: any) => { params.push(v); return `$${params.length}`; };
    const pLat = p(lat), pLng = p(lng), pR = p(radiusKm);
    // The count query also takes the remote city symbols (Postgres rejects unused params).
    const countParams = [...params, ALWAYS_MATCH_LOCATIONS];
    const pRemote = `$${countParams.length}`;
    const dist = `(${EARTH_RADIUS_KM} * 2 * asin(least(1, sqrt(
        power(sin(radians(l.lat - ${pLat}::float8) / 2), 2) +
        cos(radians(${pLat}::float8)) * cos(radians(l.lat)) * power(sin(radians(l.lng - ${pLng}::float8) / 2), 2)))))`;
    const from = `FROM jobs j JOIN locations l ON l.city_symbol = j.city_symbol WHERE ${base.join(' AND ')}`;
    const limit = Math.min(500, Math.max(1, Number(filterParams?.limit) || 500));

    const [rows, counts] = await Promise.all([
      query(
        `SELECT * FROM (SELECT ${JOB_SELECT}, l.lat AS l_lat, l.lng AS l_lng, ${dist} AS distance_km
           ${from} AND l.lat IS NOT NULL AND l.lng IS NOT NULL) x
          WHERE x.distance_km <= ${pR}::float8
          ORDER BY x.pinned_at DESC NULLS LAST, x.distance_km, GREATEST(x.publish_date, x.bumped_at) DESC, x.id DESC LIMIT ${limit}`,
        params
      ),
      queryOne<{ total: number; nocoords: number; remote: number }>(
        `SELECT COUNT(*) FILTER (WHERE l.lat IS NOT NULL AND ${dist} <= ${pR}::float8)::int AS total,
                COUNT(*) FILTER (WHERE l.lat IS NULL AND NOT (j.city_symbol = ANY(${pRemote}::int[])))::int AS nocoords,
                COUNT(*) FILTER (WHERE j.city_symbol = ANY(${pRemote}::int[]))::int AS remote
           ${from}`,
        countParams
      ),
    ]);
    const applyDefaults = await getApplyPolicyDefaults();
    const jobs = rows.map((r) => {
      const job = rowToJob(r, { applyDefaults, withContacts: opts.withContacts }) as Job & { distanceKm: number };
      job.distanceKm = Math.round(Number(r.distance_km) * 10) / 10;
      job.location = { ...job.location, lat: r.l_lat, lng: r.l_lng };
      return job;
    });
    return { jobs, total: counts?.total ?? jobs.length, withoutCoordinates: counts?.nocoords ?? 0, remote: counts?.remote ?? 0 };
  } catch (error) {
    console.error('[jobs] nearby failed', (error as Error).message);
    throw new AxiosError(JobsErrorMessages.FETCH_FAILED, JobsErrorCodes.FETCH_FAILED);
  }
};
