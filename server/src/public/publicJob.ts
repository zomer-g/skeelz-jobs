/**
 * The ONLY shapes the public API and the public MCP server may return.
 *
 * Every field is copied by name (an allowlist). A new DB column, a new field on
 * `Job`, or an admin-only field (comments, apply-policy overrides, contact
 * person, uploader...) can never reach the public surface unless someone adds
 * it here on purpose. test/public.test.mjs pins these key lists.
 *
 * Ways to apply (models/schemas/applyPolicy.ts): only the EFFECTIVE mode goes out (applyMode:
 * 'self' | 'quick' | 'none'), never the per-job overrides or the site defaults. applyContact — the
 * employer's contact for applicants, as stored on the job (contactPersonName/Phone/Email) — goes out
 * ONLY on a self-apply job, where the job page shows it to anyone anyway; on every other job it is null.
 * (Employer-form jobs only ever carry the employer's public application email there; the submission's
 * internal contact person never reaches a job.)
 *
 * extraFields: only the added job fields marked "show on the job page" (docs/settings.md), label + value.
 *
 * Deliberately left out of jobs: uploadBy, comments, status, the apply-policy overrides, the CV rules,
 * isMarked, createdAt/updatedAt.
 */
import { Job } from '../models/schemas/jobs.js';
import { JobStatus } from '../models/enums.js';
import { isPubliclyListed } from '../models/schemas/jobBoard.js';
import { DEFAULT_APPLY_POLICY, GuestMode, publicApplyMode, showsEmployerContact } from '../models/schemas/applyPolicy.js';
import { thresholdConditionOf } from '../models/schemas/thresholdCondition.js';

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

/** The employer's contact for applicants: only on a self-apply job (applyMode 'self'). */
export interface PublicApplyContact {
  name: string | null;
  email: string | null;
  phone: string | null;
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
  /** Pinned (נעוצה) by the editors: stays at the start of the lists. */
  isPinned: boolean;
  externalLink: string | null;
  /** How a visitor who is not signed in applies: self = directly with the employer, quick = the form on the
   *  job page, none = sign in first. A registered, signed-in candidate can always apply on the job page. */
  applyMode: GuestMode;
  applyContact: PublicApplyContact | null;
  /** תנאי סף: plain text a candidate must confirm on the job page before the application is accepted; null = none. */
  thresholdCondition: string | null;
  /** Details content managers added to the job form and marked "show on the job page" (active fields only):
   *  label + plain-text value, as the job page shows them. [] = none. */
  extraFields: PublicExtraField[];
  url: string;
}

export interface PublicExtraField { label: string; value: string }

export type PublicNearJob = PublicJob & { distanceKm: number };

export const PUBLIC_JOB_KEYS = ['id', 'jobNumber', 'title', 'companyName', 'description', 'jobScope', 'publishDate',
  'location', 'skills', 'isSponsored', 'isPinned', 'externalLink', 'applyMode', 'applyContact', 'thresholdCondition', 'extraFields', 'url'] as const;
export const PUBLIC_EXTRA_FIELD_KEYS = ['label', 'value'] as const;
export const PUBLIC_APPLY_CONTACT_KEYS = ['name', 'email', 'phone'] as const;
export const PUBLIC_NEAR_JOB_KEYS = [...PUBLIC_JOB_KEYS, 'distanceKm'] as const;
export const PUBLIC_LOCATION_KEYS = ['citySymbol', 'city', 'district', 'lat', 'lng'] as const;
export const PUBLIC_SKILL_KEYS = ['id', 'name'] as const;

/** The one status the public may see. Checked here AND in every query (defence in depth). */
export const isPublicStatus = (status: unknown) => status === JobStatus.ACTIVE;

/** Status AND board rules: not archived, publish date reached (jobBoard.isPubliclyListed). */
export const isPublicJob = (job: Job) => isPublicStatus(job.status) && isPubliclyListed(job as any);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const optStr = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const email = (v: unknown): string | null => {
  const s = optStr(v, 200);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};
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

const toApplyContact = (job: Job): PublicApplyContact | null => {
  const c = { name: optStr(job.contactPersonName, 100), email: email(job.contactPersonEmail), phone: optStr(job.contactPersonPhone, 30) };
  return c.name || c.email || c.phone ? c : null;
};

/** Job -> public shape, or null when the job is not public (wrong status). */
export const toPublicJob = (job: Job | null | undefined): PublicJob | null => {
  if (!job || !isPublicJob(job)) return null;
  const skillsMap = job.requiredSkillsDetails ?? {};
  const policy = job.applyPolicy ?? DEFAULT_APPLY_POLICY;
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
    isPinned: !!job.pinnedAt,
    externalLink: httpUrl(job.externalLink),
    applyMode: publicApplyMode(policy),
    applyContact: showsEmployerContact(policy) ? toApplyContact(job) : null,
    thresholdCondition: thresholdConditionOf(job.thresholdCondition),
    // Only what rowToJob put on the job page (active + "show on the job page"); copied by name, never the staff map.
    extraFields: Array.isArray((job as any).extraFields)
      ? (job as any).extraFields.map((f: any) => ({ label: str(f?.label).slice(0, 80), value: str(f?.value).slice(0, 500) })).filter((f: PublicExtraField) => f.label && f.value)
      : [],
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
