/**
 * The ONLY shapes the public API and the public MCP server may return.
 *
 * Every field is copied by name (an allowlist). A new DB column, a new field on
 * `Job`, or an admin-only field (comments, apply-policy overrides, contact
 * person, uploader...) can never reach the public surface unless someone adds
 * it here on purpose. test/public.test.mjs pins these key lists.
 *
 * Deliberately left out of jobs: contactPersonName/Phone/Email (a person's
 * details; the job page shows them only on self-apply jobs, but a bulk API
 * would make them trivially harvestable), uploadBy, comments, status, the
 * quick-apply overrides and policy, isMarked, createdAt/updatedAt.
 */
import { Job } from '../models/schemas/jobs.js';
import { JobStatus } from '../models/enums.js';
import { isPubliclyListed } from '../models/schemas/jobBoard.js';

export const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://jobs.skeelz.co.il').replace(/\/+$/, '');

export interface PublicLocation {
  citySymbol: number;
  city: string;
  district: string | null;
  lat: number | null;
  lng: number | null;
}

export interface PublicSkill {
  id: string;
  name: string;
}

export interface PublicJob {
  id: string;
  jobNumber: number;
  title: string;
  companyName: string;
  description: string;
  jobScope: string[];
  publishDate: string | null;
  location: PublicLocation | null;
  skills: PublicSkill[];
  isSponsored: boolean;
  externalLink: string | null;
  url: string;
}

export type PublicNearJob = PublicJob & { distanceKm: number };

export const PUBLIC_JOB_KEYS = ['id', 'jobNumber', 'title', 'companyName', 'description', 'jobScope', 'publishDate',
  'location', 'skills', 'isSponsored', 'externalLink', 'url'] as const;
export const PUBLIC_NEAR_JOB_KEYS = [...PUBLIC_JOB_KEYS, 'distanceKm'] as const;
export const PUBLIC_LOCATION_KEYS = ['citySymbol', 'city', 'district', 'lat', 'lng'] as const;
export const PUBLIC_SKILL_KEYS = ['id', 'name'] as const;

/** The one status the public may see. Checked here AND in every query (defence in depth). */
export const isPublicStatus = (status: unknown) => status === JobStatus.ACTIVE;

/** Status AND board rules: not private, not archived, publish date reached (jobBoard.isPubliclyListed). */
export const isPublicJob = (job: Job) => isPublicStatus(job.status) && isPubliclyListed(job as any);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const httpUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
};

export const toPublicLocation = (l: any): PublicLocation | null => {
  if (!l) return null;
  const citySymbol = num(l.citySymbol ?? l._id);
  if (citySymbol === null) return null;
  return {
    citySymbol,
    city: str(l.city),
    district: l.district === null || l.district === undefined ? null : String(l.district),
    lat: num(l.lat),
    lng: num(l.lng),
  };
};

export const toPublicSkill = (s: any): PublicSkill => ({ id: str(s?._id ?? s?.id), name: str(s?.name) });

/** Job -> public shape, or null when the job is not public (wrong status). */
export const toPublicJob = (job: Job | null | undefined): PublicJob | null => {
  if (!job || !isPublicJob(job)) return null;
  const skillsMap = job.requiredSkillsDetails ?? {};
  const loc = job.location as any;
  return {
    id: str(job._id ?? job.id),
    jobNumber: Number(job.jobId),
    title: str(job.title),
    companyName: str(job.companyName),
    description: str(job.description), // sanitized HTML (sanitizeJobHtml on write)
    jobScope: Array.isArray(job.jobScope) ? job.jobScope.map(String) : [],
    publishDate: job.publishDate ? new Date(job.publishDate).toISOString() : null,
    location: loc ? toPublicLocation({ citySymbol: job.citySymbol, city: loc.city, district: loc.district, lat: loc.lat, lng: loc.lng }) : null,
    skills: (job.requiredSkills ?? []).filter((id) => skillsMap[id] !== undefined).map((id) => ({ id: String(id), name: String(skillsMap[id]) })),
    isSponsored: job.isSponsored === true,
    externalLink: httpUrl(job.externalLink),
    url: `${PUBLIC_SITE_URL}/job/${str(job._id ?? job.id)}`,
  };
};

export const toPublicNearJob = (job: (Job & { distanceKm?: number }) | null | undefined): PublicNearJob | null => {
  const pub = toPublicJob(job);
  if (!pub) return null;
  return { ...pub, distanceKm: Number(job!.distanceKm) };
};

/** Drops non-public rows and maps the rest. */
export const publicJobs = (jobs: Job[]): PublicJob[] =>
  jobs.map(toPublicJob).filter((j): j is PublicJob => j !== null);
