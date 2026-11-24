/* ============================================================================
 *  Pure part of the candidates mirror (services/legacyCandidates.ts): a Contact
 *  of the existing site → the candidate row here, and the newest CV file on it.
 *  No database, no Salesforce: unit-tested (test/unit/legacyCandidates.test.ts).
 * ========================================================================== */
import { GENDERS, phoneOk } from '../security/pure.js';

/** Contact fields read (those the org has). The existing site writes the *_cambium__c ones; the Retrain candidates
 *  (an earlier system, 11.2026: name, email and phone only) have the standard ones. Never logged. */
export const LEGACY_CONTACT_FIELDS = [
  'AccountId', 'ID_cambium__c', 'FirstName', 'LastName', 'Email', 'MobilePhone', 'Phone', 'Birthdate', 'MailingCity',
  'firstName_cambium__c', 'lastName_cambium__c', 'email_cambium__c', 'phoneNumber_cambium__c', 'dateOfBirth_cambium__c',
  'gender_cambium__c', 'citySymbol_cambium__c', 'skills_cambium__c',
] as const;

export type MirroredCandidate = {
  sfId: string;
  cid: string | null;          // ID_cambium__c (the application Cases name it in A_CID_cambium__c)
  accountId: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string | null;
  dateOfBirth: Date | null;
  gender: string;
  citySymbol: number;
  skills: string[];
  modifiedAt: string;
};

export type CandidateContext = {
  /** Accounts whose Contacts without a date of birth and gender are quick applications (the existing site's
   *  candidates' Account): owner, 20.11.2026 — quick applicants are not copied. */
  quickAccounts: Set<string>;
  skillIds: Set<string>;
  citySymbols: Set<number>;
  cityByName: Map<string, number>;
  now?: Date;
};

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** An Israeli number in this site's form (digits only, leading 0), or null. */
export const normalizePhone = (raw: unknown): string | null => {
  let d = str(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('972') && d.length >= 11) d = '0' + d.slice(3);
  d = d.replace(/\D/g, '');
  if (d && !d.startsWith('0')) d = '0' + d;
  return phoneOk(d) ? d : null;
};

/** A plausible date of birth (14 to 120 years ago), else null. */
export const normalizeBirthDate = (raw: unknown, now = new Date()): Date | null => {
  const s = str(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const age = (now.getTime() - d.getTime()) / (365.25 * 86_400_000);
  return age >= 14 && age <= 120 ? d : null;
};

const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v);

/**
 * One Contact → the candidate here, or why it is not copied: 'no_email', 'no_name', 'quick_application'.
 * The existing site's fields win over the standard ones (it keeps them current).
 */
export const contactToCandidate = (c: Record<string, unknown>, ctx: CandidateContext):
  { ok: true; candidate: MirroredCandidate } | { ok: false; code: string } => {
  const accountId = str(c.AccountId);
  const email = (str(c.email_cambium__c) || str(c.Email)).toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, code: 'no_email' };
  const dobRaw = str(c.dateOfBirth_cambium__c) || str(c.Birthdate);
  const genderRaw = str(c.gender_cambium__c).toLowerCase();
  if (ctx.quickAccounts.has(accountId) && !dobRaw && !genderRaw) return { ok: false, code: 'quick_application' };
  const firstName = clip(str(c.firstName_cambium__c) || str(c.FirstName), 60);
  const lastName = clip(str(c.lastName_cambium__c) || str(c.LastName), 60);
  if (!firstName && !lastName) return { ok: false, code: 'no_name' };

  const symbol = Number(str(c.citySymbol_cambium__c));
  const byName = ctx.cityByName.get(str(c.MailingCity).toLowerCase());
  const citySymbol = Number.isInteger(symbol) && symbol > 0 && ctx.citySymbols.has(symbol) ? symbol : byName ?? 0;
  const skills = [...new Set(str(c.skills_cambium__c).split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => ctx.skillIds.has(s)))];
  const cid = str(c.ID_cambium__c) || null;
  return {
    ok: true,
    candidate: {
      sfId: str(c.Id),
      cid,
      accountId,
      email,
      firstName,
      lastName,
      phoneNumber: normalizePhone(str(c.phoneNumber_cambium__c) || str(c.MobilePhone) || str(c.Phone)),
      dateOfBirth: normalizeBirthDate(dobRaw, ctx.now),
      gender: GENDERS.includes(genderRaw) ? genderRaw : '',
      citySymbol,
      skills,
      modifiedAt: str(c.LastModifiedDate),
    },
  };
};

export type CvFile = { versionId: string; title: string; ext: string; at: string };
const CV_EXT = new Set(['pdf', 'doc', 'docx']);

/** The newest CV-like file (pdf / doc / docx) of each Contact, from ContentDocumentLink rows. */
export const newestCvs = (links: Record<string, any>[]): Map<string, CvFile> => {
  const out = new Map<string, CvFile>();
  for (const l of links) {
    const d = l?.ContentDocument ?? {};
    const ext = str(d.FileExtension).toLowerCase();
    const versionId = str(d.LatestPublishedVersionId);
    if (!CV_EXT.has(ext) || !/^068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(versionId)) continue;
    const at = str(d.ContentModifiedDate);
    const who = str(l.LinkedEntityId);
    const cur = out.get(who);
    if (!cur || at > cur.at) out.set(who, { versionId, title: clip(str(d.Title) || 'cv', 120), ext, at });
  }
  return out;
};

/** The pointer kept in cv_file_url for a CV that stays in Salesforce (opened only on demand). */
export const SF_CV_PREFIX = 'sf:';
export const sfCvKey = (versionId: string) => `${SF_CV_PREFIX}${versionId}`;
export const isSfCvKey = (v: unknown): v is string => typeof v === 'string' && /^sf:068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(v);
/** A file name to download as: the Title without characters a file name can't have, plus the extension. */
export const sfCvFileName = (cv: Pick<CvFile, 'title' | 'ext'>) =>
  `${(cv.title || 'cv').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 100) || 'cv'}.${cv.ext || 'pdf'}`;

/** Columns the mirror keeps equal to the Contact, and their values for a candidate. */
export const candidateColumns = (m: MirroredCandidate) => ({
  first_name: m.firstName, last_name: m.lastName, email: m.email, phone_number: m.phoneNumber,
  date_of_birth: m.dateOfBirth, gender: m.gender, city_symbol: m.citySymbol, skills: m.skills,
});

const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a as any).getTime() : null;
    const tb = b ? new Date(b as any).getTime() : null;
    return ta === tb;
  }
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify([...(a as any[] ?? [])].sort()) === JSON.stringify([...(b as any[] ?? [])].sort());
  return (a ?? null) === (b ?? null);
};

/** What differs between the stored row and the Contact (column → new value). */
export const changedCandidateColumns = (stored: Record<string, any>, m: MirroredCandidate): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(candidateColumns(m))) if (!same(stored[col], v)) out[col] = v;
  return out;
};

/** For an account made here with the same email: only what is empty here is filled (once, when first linked). */
export const fillEmptyColumns = (stored: Record<string, any>, m: MirroredCandidate): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const empty = (v: unknown) => v === null || v === undefined || v === '' || v === 0 || (Array.isArray(v) && !v.length);
  for (const [col, v] of Object.entries(candidateColumns(m))) {
    if (col === 'email') continue;
    if (empty(stored[col]) && !empty(v)) out[col] = v;
  }
  return out;
};

/** Contact fields this site never changes on a Contact of the existing site, even after the cutover. */
export const NEVER_WRITTEN_ON_LEGACY = ['ID_cambium__c', 'AccountId', 'OwnerId', 'RecordTypeId'] as const;

/**
 * After the cutover (owner, 20.11.2026: full writing): the update a mirrored candidate's Contact gets — every value
 * this site has, never an empty one (nothing is cleared), never the fields above, never a Beta mark, and the CV link
 * only for a CV kept here (a CV that is still the Contact's own file is already there).
 */
export const fullContactPatch = (body: Record<string, unknown>, betaField: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if ((NEVER_WRITTEN_ON_LEGACY as readonly string[]).includes(k) || k === betaField) continue;
    if (v === null || v === undefined || v === '') continue;
    if (k === 'CV_link_cambium__c' && typeof v === 'string' && v.startsWith(SF_CV_PREFIX)) continue;
    out[k] = v;
  }
  return out;
};
