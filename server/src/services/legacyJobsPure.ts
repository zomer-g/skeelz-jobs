/* ============================================================================
 *  The existing site's jobs, read from Salesforce: the pure rules (unit-tested in
 *  test/unit/legacyJobs.test.ts). services/legacyJobs.ts does the reading and the
 *  writing; docs/jobs-management.md "Jobs of the existing site" has the owner's view.
 *
 *  A Position Case (record type Position, Account "משרות קמביום") that the existing
 *  site wrote carries the job in the same fields this site writes for its own jobs
 *  (salesforceUtils.formatJobToSalesforceJobCase), PID_cambium__c = the job's _id.
 *  caseToJob() reads those fields back, tolerant of the forms they may come in
 *  (ids or names, commas or semicolons, HTML or plain text, HTML entities).
 *  The existing site's public API, when it is set (LEGACY_PUBLIC_API), adds what
 *  Salesforce does not have: the job number and the description as formatted there.
 * ========================================================================== */

export const LEGACY_CASE_FIELDS = [
  'PID_cambium__c', 'Position_cambium__c', 'company_cambium__c', 'PLocation_cambium__c', 'citySymbol_cambium__c', 'PTime_cambium__c',
  'PSkills_cambium__c', 'PDescription_cambium__c', 'PComments_cambium__c', 'PFullName_cambium__c', 'PPhone_cambium__c', 'PEmail_cambium__c',
  'PStatus__c', 'PCreatedDate_cambium__c', 'PModifiedDate_cambium__c', 'isSponserd_cambium__c', 'isMarked_cambium__c', 'isSelfApply_cambium__c',
  'PLink_cambium__c',
] as const;

/**
 * The existing site's job number, from the link it writes on the Case (PLink_cambium__c, e.g.
 * "jobs.skeelz.co.il/job/1910"; seen in the org 11.2026). Null when the link has no number.
 */
export const jobNumberFromLink = (raw: unknown): number | null => {
  const m = /\/job\/(\d{1,7})(?:[/?#]|$)/.exec(String(raw ?? '').trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The line salesforceUtils adds to PComments_cambium__c for an external apply link (same text, kept in sync). */
export const EXTERNAL_LINK_LINE = 'קישור חיצוני להגשה:';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
export const isLegacyJobId = (v: unknown): v is string => typeof v === 'string' && OBJECT_ID.test(v);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** &quot; &amp; &#1488; &#x5D0; … → characters (the existing site's comments arrive with entities). */
export const decodeEntities = (s: string): string => s
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
  .replace(/&#(\d{1,7});/g, (_, d) => safeChar(Number(d)))
  .replace(/&([a-z]+|#39);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const safeChar = (code: number) => (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '');

const text = (v: unknown): string => (v === null || v === undefined ? '' : decodeEntities(String(v)).replace(/\r\n?/g, '\n').trim());
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';

/** The text of some HTML, whitespace collapsed: to tell whether two descriptions say the same thing. */
export const plainText = (html: string): string => decodeEntities(String(html ?? '')
  .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
  .replace(/<[^>]*>/g, ' '))
  .replace(/[•·▪●]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const looksLikeHtml = (s: string): boolean => /<\s*\/?\s*(p|div|br|ul|ol|li|h[1-6]|strong|b|em|i|u|span|a)\b[^>]*>/i.test(s);

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text → simple HTML: a paragraph per blank-line block, line breaks kept. */
export const textToHtml = (s: string): string => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

const SCOPE_WORDS: Record<string, 'FullTime' | 'PartialTime'> = {
  fulltime: 'FullTime', 'full time': 'FullTime', 'מלאה': 'FullTime', 'משרה מלאה': 'FullTime',
  partialtime: 'PartialTime', 'partial time': 'PartialTime', parttime: 'PartialTime', 'part time': 'PartialTime',
  'חלקית': 'PartialTime', 'משרה חלקית': 'PartialTime',
};
export const parseScope = (raw: unknown): ('FullTime' | 'PartialTime')[] => {
  const out = new Set<'FullTime' | 'PartialTime'>();
  for (const t of text(raw).split(/[,;|\n]+/)) {
    const k = SCOPE_WORDS[t.trim().toLowerCase()];
    if (k) out.add(k);
  }
  return [...out];
};

/** Skill ids (24 hex, known here) or skill names (mapped to their id); unknown ones are left out. */
export const parseSkills = (raw: unknown, known: { ids: Set<string>; byName: Map<string, string> }): string[] => {
  const out = new Set<string>();
  for (const t of text(raw).split(/[,;|\n]+/).map((x) => x.trim()).filter(Boolean)) {
    if (OBJECT_ID.test(t) && known.ids.has(t.toLowerCase())) out.add(t.toLowerCase());
    else {
      const id = known.byName.get(t.toLowerCase());
      if (id) out.add(id);
    }
  }
  return [...out];
};

export const parseStatus = (raw: unknown): 'Active' | 'Suspended' | 'Closed' => {
  const s = text(raw).toLowerCase();
  return s === 'active' ? 'Active' : s === 'suspended' ? 'Suspended' : 'Closed'; // empty (the oldest jobs) = closed
};

/** PComments_cambium__c → the internal comments and, when there is one, the external apply link line. */
export const splitComments = (raw: unknown): { comments: string; externalLink: string | null } => {
  let externalLink: string | null = null;
  const lines = text(raw).split('\n').filter((line) => {
    const t = line.trim();
    if (t.startsWith(EXTERNAL_LINK_LINE)) {
      const url = t.slice(EXTERNAL_LINK_LINE.length).trim();
      if (/^https?:\/\/\S+$/i.test(url)) { externalLink = url; return false; }
    }
    return true;
  });
  return { comments: lines.join('\n').trim(), externalLink };
};

const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const latest = (...ds: (Date | null)[]): Date | null => {
  const ok = ds.filter((d): d is Date => !!d);
  return ok.length ? new Date(Math.max(...ok.map((d) => d.getTime()))) : null;
};

/** The existing site's public board entry for a job (GET /jobs/active), as importFromLive reads it. */
export type PublicJob = {
  _id: string; jobId?: number | string; title?: string; description?: string; companyName?: string; citySymbol?: number | string;
  jobScope?: string[]; requiredSkills?: string[]; externalLink?: string | null; uploadBy?: string | null;
  publishDate?: string; createdAt?: string; updatedAt?: string; status?: string;
  contactPersonName?: string | null; contactPersonPhone?: string | null; contactPersonEmail?: string | null;
  isSponsored?: boolean; isMarked?: boolean; isSelfApply?: boolean;
};

/** What the mirror stores for one job (columns of `jobs`). */
export type MirroredJob = {
  id: string; jobNumber: number | null; title: string; companyName: string; citySymbol: number; jobScope: string[]; requiredSkills: string[];
  description: string; comments: string | null; externalLink: string | null; uploadBy: string | null;
  contactPersonName: string | null; contactPersonPhone: string | null; contactPersonEmail: string | null;
  status: 'Active' | 'Suspended' | 'Closed'; isSponsored: boolean; isMarked: boolean; isSelfApply: boolean;
  publishDate: Date; createdAt: Date; updatedAt: Date; sfId: string | null;
};

export type CaseContext = {
  skills: { ids: Set<string>; byName: Map<string, string> };
  /** city name (lower case) → city symbol, for a Case with a city name but no symbol. */
  cityByName: Map<string, number>;
  /** The job on the existing site's public board, when the public API is read. */
  publicJob?: PublicJob;
  /** What is stored here now (the description is kept when it says the same as Salesforce's). */
  existingDescription?: string | null;
  /** HTML cleaner (utils/sanitize.sanitizeJobHtml), passed in to keep this module pure. */
  sanitize: (html: string) => string;
  now?: Date;
};

export type CaseResult = { ok: true; job: MirroredJob } | { ok: false; code: 'bad_pid' | 'no_title' | 'no_city' };

const cityOf = (c: Record<string, unknown>, ctx: CaseContext): number | null => {
  const n = Number(text(c.citySymbol_cambium__c));
  if (text(c.citySymbol_cambium__c) && Number.isInteger(n)) return n;
  const byName = ctx.cityByName.get(text(c.PLocation_cambium__c).toLowerCase());
  if (byName !== undefined) return byName;
  const p = Number(ctx.publicJob?.citySymbol);
  return ctx.publicJob && Number.isInteger(p) ? p : null;
};

/**
 * The description: the existing site's own (formatted) one when its public board has the job; else Salesforce's —
 * HTML as is (cleaned), plain text kept as the stored description when it says the same, otherwise turned into
 * paragraphs. Nothing in Salesforce = what is stored (or the public one).
 */
const descriptionOf = (raw: unknown, ctx: CaseContext): string => {
  if (ctx.publicJob?.description) return ctx.sanitize(String(ctx.publicJob.description));
  const sf = raw === null || raw === undefined ? '' : String(raw).replace(/\r\n?/g, '\n').trim();
  if (!sf) return ctx.existingDescription ?? '';
  if (looksLikeHtml(sf)) return ctx.sanitize(sf);
  const t = decodeEntities(sf);
  if (ctx.existingDescription && plainText(ctx.existingDescription) === plainText(t)) return ctx.existingDescription;
  return ctx.sanitize(textToHtml(t));
};

/** One Position Case (plus the public board entry, if any) → the job as stored here, or why it is skipped. */
export const caseToJob = (c: Record<string, unknown>, ctx: CaseContext): CaseResult => {
  const id = text(c.PID_cambium__c).toLowerCase();
  if (!OBJECT_ID.test(id)) return { ok: false, code: 'bad_pid' };
  const p = ctx.publicJob;
  const title = text(c.Position_cambium__c) || text(p?.title);
  if (!title) return { ok: false, code: 'no_title' };
  const citySymbol = cityOf(c, ctx);
  if (citySymbol === null) return { ok: false, code: 'no_city' };
  const { comments, externalLink } = splitComments(c.PComments_cambium__c);
  const scope = parseScope(c.PTime_cambium__c);
  const skills = parseSkills(c.PSkills_cambium__c, ctx.skills);
  const now = ctx.now ?? new Date();
  const created = date(p?.createdAt) ?? date(c.CreatedDate) ?? now;
  // The number: the public board's, else the one in the Case's link (every job has it, closed ones too).
  const boardNumber = Number(p?.jobId);
  const jobNumber = Number.isInteger(boardNumber) && boardNumber > 0 ? boardNumber : jobNumberFromLink(c.PLink_cambium__c);
  return {
    ok: true,
    job: {
      id,
      jobNumber,
      title,
      companyName: text(c.company_cambium__c) || text(p?.companyName),
      citySymbol,
      jobScope: scope.length ? scope : (p?.jobScope ?? []).filter((s) => s === 'FullTime' || s === 'PartialTime'),
      requiredSkills: skills.length ? skills : (p?.requiredSkills ?? []).filter((s) => OBJECT_ID.test(s) && ctx.skills.ids.has(s.toLowerCase())),
      description: descriptionOf(c.PDescription_cambium__c, ctx),
      comments: comments || null,
      externalLink: externalLink ?? (p?.externalLink ? String(p.externalLink) : null),
      uploadBy: p?.uploadBy ? String(p.uploadBy) : null,
      contactPersonName: text(c.PFullName_cambium__c) || null,
      contactPersonPhone: text(c.PPhone_cambium__c) || null,
      contactPersonEmail: text(c.PEmail_cambium__c) || null,
      status: parseStatus(c.PStatus__c),
      isSponsored: bool(c.isSponserd_cambium__c),
      isMarked: bool(c.isMarked_cambium__c),
      isSelfApply: bool(c.isSelfApply_cambium__c),
      publishDate: date(c.PCreatedDate_cambium__c) ?? date(p?.publishDate) ?? created,
      createdAt: created,
      // The later of the existing site's own time and the Case's (a change made in Salesforce moves only the latter).
      updatedAt: latest(date(c.PModifiedDate_cambium__c), date(c.LastModifiedDate)) ?? now,
      sfId: c.Id ? String(c.Id) : null,
    },
  };
};

/** A job on the public board that has no Position Case (yet): read from the board alone. */
export const publicToJob = (p: PublicJob, ctx: Omit<CaseContext, 'publicJob'>): CaseResult => {
  const id = String(p._id ?? '').toLowerCase();
  if (!OBJECT_ID.test(id)) return { ok: false, code: 'bad_pid' };
  const title = text(p.title);
  if (!title) return { ok: false, code: 'no_title' };
  const city = Number(p.citySymbol);
  if (!Number.isInteger(city)) return { ok: false, code: 'no_city' };
  const now = ctx.now ?? new Date();
  const jobNumber = Number(p.jobId);
  return {
    ok: true,
    job: {
      id, jobNumber: Number.isInteger(jobNumber) && jobNumber > 0 ? jobNumber : null, title, companyName: text(p.companyName), citySymbol: city,
      jobScope: (p.jobScope ?? []).filter((s) => s === 'FullTime' || s === 'PartialTime'),
      requiredSkills: (p.requiredSkills ?? []).filter((s) => OBJECT_ID.test(s) && ctx.skills.ids.has(s.toLowerCase())),
      description: ctx.sanitize(String(p.description ?? '')), comments: null,
      externalLink: p.externalLink ? String(p.externalLink) : null, uploadBy: p.uploadBy ? String(p.uploadBy) : null,
      contactPersonName: p.contactPersonName ?? null, contactPersonPhone: p.contactPersonPhone ?? null, contactPersonEmail: p.contactPersonEmail ?? null,
      status: parseStatus(p.status ?? 'Active'), isSponsored: !!p.isSponsored, isMarked: !!p.isMarked, isSelfApply: !!p.isSelfApply,
      publishDate: date(p.publishDate) ?? now, createdAt: date(p.createdAt) ?? now, updatedAt: date(p.updatedAt) ?? now, sfId: null,
    },
  };
};

/** The stored columns the mirror owns, and how a MirroredJob fills them. */
export const MIRROR_COLUMNS: { column: string; of: (j: MirroredJob) => unknown }[] = [
  { column: 'title', of: (j) => j.title },
  { column: 'company_name', of: (j) => j.companyName },
  { column: 'city_symbol', of: (j) => j.citySymbol },
  { column: 'job_scope', of: (j) => j.jobScope },
  { column: 'required_skills', of: (j) => j.requiredSkills },
  { column: 'description', of: (j) => j.description },
  { column: 'comments', of: (j) => j.comments },
  { column: 'external_link', of: (j) => j.externalLink },
  { column: 'contact_person_name', of: (j) => j.contactPersonName },
  { column: 'contact_person_phone', of: (j) => j.contactPersonPhone },
  { column: 'contact_person_email', of: (j) => j.contactPersonEmail },
  { column: 'status', of: (j) => j.status },
  { column: 'is_sponsored', of: (j) => j.isSponsored },
  { column: 'is_marked', of: (j) => j.isMarked },
  { column: 'is_self_apply', of: (j) => j.isSelfApply },
  // A self-apply job applies directly with the employer, as on the existing site (importFromLive does the same).
  { column: 'guest_mode_override', of: (j) => (j.isSelfApply ? 'self' : null) },
  { column: 'publish_date', of: (j) => j.publishDate },
];

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a as any).getTime() : NaN;
    const tb = b ? new Date(b as any).getTime() : NaN;
    return ta === tb || (Number.isNaN(ta) && Number.isNaN(tb));
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
};

/** Columns whose stored value differs from the job read now (upload_by only fills an empty one). */
export const changedColumns = (stored: Record<string, unknown>, j: MirroredJob): { column: string; value: unknown }[] => {
  const out = MIRROR_COLUMNS.filter((c) => !same(stored[c.column], c.of(j))).map((c) => ({ column: c.column, value: c.of(j) }));
  if (j.uploadBy && !stored.upload_by) out.push({ column: 'upload_by', value: j.uploadBy });
  return out;
};

/** Watermark for the next read: the newest LastModifiedDate seen, minus a safety margin (re-reading is harmless). */
export const nextWatermark = (previous: string | null, seen: string[], marginMs = 2 * 60_000): string | null => {
  const times = seen.map((s) => new Date(s).getTime()).filter((t) => !Number.isNaN(t));
  if (!times.length) return previous;
  const t = Math.max(...times) - marginMs;
  const prev = previous ? new Date(previous).getTime() : NaN;
  return new Date(Number.isNaN(prev) ? t : Math.max(t, prev)).toISOString();
};

/** SOQL datetime literal (no quotes): only a valid ISO time passes. */
export const soqlDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('invalid time for SOQL');
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};
