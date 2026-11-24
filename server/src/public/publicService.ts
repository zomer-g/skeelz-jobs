/**
 * The one service layer behind the public REST API (/api/public/v1) and the
 * public MCP server (/mcp). Read-only. Returns only the allowlisted shapes from
 * publicJob.ts, and only jobs whose status is Active — checked in the query
 * (explicit `j.status = 'Active'`) and again in toPublicJob.
 *
 * Nothing here reads users, applications, CVs, submissions, settings or the
 * activity log, and nothing here writes.
 */
import * as jobDAL from '../dal/jobDAL.js';
import * as locationDAL from '../dal/locationDAL.js';
import * as skillsDAL from '../dal/skillsDAL.js';
import { filterOptions } from '../models/interfaces/general.interface.js';
import { isObjectId } from '../utils/ids.js';
import {
  PublicJob, PublicLocation, PublicNearJob, PublicSkill,
  publicJobs, toPublicJob, toPublicLocation, toPublicNearJob, toPublicSkill,
} from './publicJob.js';
import { JobSearchInput, NearInput, PUBLIC_LIMITS, PublicInputError } from './publicParams.js';
import { PUBLIC_LISTING_SQL } from '../models/schemas/jobBoard.js';

/** The public status filter, spelled out (do not replace with a "not hidden" rule). */
export const PUBLIC_JOB_WHERE = `j.status = 'Active'`;
/** Plus: not private, not archived, publish date reached (models/schemas/jobBoard.ts). Lists are in the
 *  public order there: pinned first (latest pin on top), then publish date, newest first. */
export const PUBLIC_WHERE = [PUBLIC_JOB_WHERE, PUBLIC_LISTING_SQL('j')];

// Locations and skills change rarely and are the same for everyone.
const CACHE_MS = 5 * 60 * 1000;
let locCache: { at: number; data: PublicLocation[] } = { at: 0, data: [] };
let skillCache: { at: number; data: PublicSkill[] } = { at: 0, data: [] };

export const listLocations = async (): Promise<PublicLocation[]> => {
  if (Date.now() - locCache.at < CACHE_MS) return locCache.data;
  const rows = await locationDAL.findAllLocations();
  const data = rows.map(toPublicLocation).filter((l): l is PublicLocation => l !== null);
  locCache = { at: Date.now(), data };
  return data;
};

export const listSkills = async (): Promise<PublicSkill[]> => {
  if (Date.now() - skillCache.at < CACHE_MS) return skillCache.data;
  const data = (await skillsDAL.findAll()).map(toPublicSkill).filter((s) => s.id && s.name);
  skillCache = { at: Date.now(), data };
  return data;
};

/** Loose name match: case, spaces, hyphens and quotes ignored ("תל אביב" = "תל-אביב"). */
export const norm = (s: string) => s.toLocaleLowerCase('he').replace(/[\s\-־"'`׳״.,()]/g, '');

/** City symbols / names / district names -> the site's city + district filters. */
export const resolveLocations = async (values: string[]): Promise<{ citySymbols: number[]; districts: string[] }> => {
  if (!values.length) return { citySymbols: [], districts: [] };
  const all = await listLocations();
  const citySymbols = new Set<number>();
  const districts = new Set<string>();
  for (const v of values) {
    if (/^-?\d+$/.test(v)) {
      const n = Number(v);
      if (!all.some((l) => l.citySymbol === n)) throw new PublicInputError(`unknown location ${v} (see list_locations / /locations)`);
      citySymbols.add(n);
      continue;
    }
    const k = norm(v);
    if (!k) throw new PublicInputError('empty location');
    const city = all.filter((l) => norm(l.city) === k);
    if (city.length) { city.forEach((l) => citySymbols.add(l.citySymbol)); continue; }
    const district = all.find((l) => l.district && norm(l.district) === k);
    if (district) { districts.add(district.district!); continue; }
    const partial = all.filter((l) => norm(l.city).includes(k)).slice(0, PUBLIC_LIMITS.maxFilterValues);
    if (partial.length) { partial.forEach((l) => citySymbols.add(l.citySymbol)); continue; }
    throw new PublicInputError(`unknown location "${v.slice(0, 40)}" (see list_locations / /locations)`);
  }
  return { citySymbols: [...citySymbols], districts: [...districts] };
};

/** Skill ids or names -> skill ids. */
export const resolveSkills = async (values: string[]): Promise<string[]> => {
  if (!values.length) return [];
  const all = await listSkills();
  const ids = new Set<string>();
  for (const v of values) {
    if (isObjectId(v)) {
      if (!all.some((s) => s.id === v)) throw new PublicInputError(`unknown skill ${v} (see list_skills / /skills)`);
      ids.add(v);
      continue;
    }
    const k = norm(v);
    if (!k) throw new PublicInputError('empty skill');
    const exact = all.filter((s) => norm(s.name) === k);
    const hits = exact.length ? exact : all.filter((s) => norm(s.name).includes(k)).slice(0, PUBLIC_LIMITS.maxFilterValues);
    if (!hits.length) throw new PublicInputError(`unknown skill "${String(v).slice(0, 40)}" (see list_skills / /skills)`);
    hits.forEach((s) => ids.add(s.id));
  }
  return [...ids];
};

export interface JobPage { data: PublicJob[]; page: number; limit: number; total: number }
export interface NearPage {
  data: PublicNearJob[]; page: number; limit: number; total: number;
  /** Active remote / nationwide jobs (not on the map). */
  remote: number;
  /** Active jobs whose town has no coordinates yet. */
  withoutCoordinates: number;
}

const baseFilter = async (input: JobSearchInput): Promise<filterOptions> => ({
  inputValue: input.q,
  jobSkillsIds: await resolveSkills(input.skills),
  jobScopeIds: input.scopes,
});

/** Jobs near a point, nearest first (location filters are replaced by the radius). */
export const jobsNear = async (input: JobSearchInput & { near: NearInput }): Promise<NearPage> => {
  const { lat, lng, radiusKm } = input.near;
  // withContacts: the public API / MCP carry the employer's contact on self-apply jobs (applyContact, publicJob.ts).
  const r = await jobDAL.findActiveJobsNear(lat, lng, radiusKm, { ...(await baseFilter(input)), limit: PUBLIC_LIMITS.maxNearResults }, { withContacts: true });
  const all = r.jobs.map(toPublicNearJob).filter((j): j is PublicNearJob => j !== null);
  const start = (input.page - 1) * input.limit;
  return {
    data: all.slice(start, start + input.limit),
    page: input.page,
    limit: input.limit,
    total: Math.min(r.total, PUBLIC_LIMITS.maxNearResults),
    remote: r.remote,
    withoutCoordinates: r.withoutCoordinates,
  };
};

/** List / search active jobs. With a point, it is the near search. */
export const searchJobs = async (input: JobSearchInput): Promise<JobPage | NearPage> => {
  if (input.near) return jobsNear(input as JobSearchInput & { near: NearInput });
  const { citySymbols, districts } = await resolveLocations(input.locations);
  const filter: filterOptions = {
    ...(await baseFilter(input)),
    jobCitySymbol: citySymbols,
    jobDistricts: districts,
    page: input.page,
    limit: input.limit,
  };
  const { jobs, total } = await jobDAL.findJobs(filter, PUBLIC_WHERE, { withContacts: true });
  return { data: publicJobs(jobs), page: input.page, limit: input.limit, total };
};

/** One active job by id or job number; null when missing or not public. */
export const getJob = async (ref: { id: string } | { number: number }): Promise<PublicJob | null> => {
  const id = 'id' in ref ? ref.id : await jobDAL.findPublicIdByJobNumber(ref.number);
  if (!id) return null;
  return toPublicJob(await jobDAL.findJobByJobId(id));
};
