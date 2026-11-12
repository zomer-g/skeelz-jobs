/**
 * Input rules for the public API / MCP server (pure, no DB). Everything a caller
 * sends is bounded here: hard page-size cap, short text, few filter values,
 * coordinates inside Israel. Unknown parameters are ignored.
 */
import { isObjectId } from '../utils/ids.js';
import { JobScope } from '../models/enums.js';

export const PUBLIC_LIMITS = {
  /** Hard cap on items per page (list and near). */
  maxPageSize: 100,
  defaultPageSize: 20,
  /** Deepest page (page * size <= 10,000). */
  maxOffset: 10_000,
  maxTextLength: 100,
  maxFilterValues: 20,
  maxRadiusKm: 200,
  /** The near search reads at most this many nearest jobs, then pages through them. */
  maxNearResults: 500,
  /** Requests per IP per minute. */
  restPerMinute: 120,
  mcpPerMinute: 60,
};

// Israel and a margin around it (same box the map search uses).
export const NEAR_BOUNDS = { minLat: 29, maxLat: 34, minLng: 34, maxLng: 36.5 };

export class PublicInputError extends Error {
  status = 400;
}

export interface NearInput { lat: number; lng: number; radiusKm: number }

export interface JobSearchInput {
  q?: string;
  /** City symbols (numbers) or city / district names (resolved by the service). */
  locations: string[];
  /** Skill ids or skill names (resolved by the service). */
  skills: string[];
  scopes: string[];
  near?: NearInput;
  page: number;
  limit: number;
}

const list = (v: unknown, name: string): string[] => {
  const raw = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  const out = raw.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).split(',') : []))
    .map((s) => s.trim()).filter(Boolean);
  if (out.length > PUBLIC_LIMITS.maxFilterValues) throw new PublicInputError(`${name}: at most ${PUBLIC_LIMITS.maxFilterValues} values`);
  for (const s of out) if (s.length > PUBLIC_LIMITS.maxTextLength) throw new PublicInputError(`${name}: value too long`);
  return Array.from(new Set(out));
};

const text = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') throw new PublicInputError(`${name} must be a string`);
  const s = String(v).trim();
  if (s.length > PUBLIC_LIMITS.maxTextLength) throw new PublicInputError(`${name}: at most ${PUBLIC_LIMITS.maxTextLength} characters`);
  return s || undefined;
};

const int = (v: unknown, name: string, dflt: number, min: number, max: number): number => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PublicInputError(`${name} must be an integer ${min}-${max}`);
  return n;
};

export const parseNear = (lat: unknown, lng: unknown, radiusKm: unknown, required: boolean): NearInput | undefined => {
  const given = [lat, lng, radiusKm].filter((v) => v !== undefined && v !== null && v !== '');
  if (!given.length && !required) return undefined;
  const n = { lat: Number(lat), lng: Number(lng), radiusKm: Number(radiusKm) };
  if (given.length !== 3 || ![n.lat, n.lng, n.radiusKm].every(Number.isFinite)
    || n.lat < NEAR_BOUNDS.minLat || n.lat > NEAR_BOUNDS.maxLat
    || n.lng < NEAR_BOUNDS.minLng || n.lng > NEAR_BOUNDS.maxLng
    || n.radiusKm <= 0 || n.radiusKm > PUBLIC_LIMITS.maxRadiusKm) {
    throw new PublicInputError(`lat, lng (inside Israel) and radiusKm (0-${PUBLIC_LIMITS.maxRadiusKm}) are required together`);
  }
  return n;
};

const SCOPES = new Set<string>(Object.values(JobScope));

/** Query-string / tool arguments -> bounded search input. */
export const parseJobSearch = (a: Record<string, unknown>, opts: { nearRequired?: boolean } = {}): JobSearchInput => {
  const limit = int(a.limit, 'limit', PUBLIC_LIMITS.defaultPageSize, 1, PUBLIC_LIMITS.maxPageSize);
  const page = int(a.page, 'page', 1, 1, Math.floor(PUBLIC_LIMITS.maxOffset / limit));
  const scopes = list(a.scope, 'scope');
  for (const s of scopes) if (!SCOPES.has(s)) throw new PublicInputError(`scope must be one of ${[...SCOPES].join(', ')}`);
  return {
    q: text(a.q, 'q'),
    locations: list(a.location, 'location'),
    skills: list(a.skills, 'skills'),
    scopes,
    near: parseNear(a.lat, a.lng, a.radiusKm, !!opts.nearRequired),
    page,
    limit,
  };
};

/** A job is addressed by its public id (24 hex) or its job number. */
export const parseJobRef = (v: unknown): { id: string } | { number: number } => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  if (isObjectId(s)) return { id: s };
  if (/^\d{1,9}$/.test(s)) return { number: Number(s) };
  throw new PublicInputError('id must be a job id (24 hex characters) or a job number');
};
