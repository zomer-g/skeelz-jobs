import { CreateUserDto } from "../dto/createUserDto.js";
import { IUser } from "../models/schemas/user.js";
import { UpdateUserDto } from "../dto/updateUserDto.js";
import { usersFilter } from "../models/interfaces/general.interface.js";
import { escapeLike, query, queryOne } from "../config/db.js";
import { isObjectId, newObjectId } from "../utils/ids.js";
import { UserRole, blockedOf, isCandidate, rolesOf } from "../models/enums.js";
import { ownYesClearsRemoval, STATUS_SQL } from './marketingDAL.js';
import { isMarketingStatus, marketingStatus } from '../security/marketing.js';
import { TERMS_VERSION } from "../security/consent.js";
import { CandidateReadOnlyError } from "../middleware/errorMiddleware.js";
import { mergeCustomValues, shownValues } from "../models/schemas/customFields.js";
import { definitionsOf } from "../services/customFieldsService.js";

const SORT_COLUMNS: Record<string, string> = {
  _id: 'u.id',
  firstName: 'u.first_name',
  lastName: 'u.last_name',
  email: 'u.email',
  phoneNumber: 'u.phone_number',
  dateOfBirth: 'u.date_of_birth',
  createdAt: 'u.created_at',
  location: 'l.city',
};

// The stored password hash is never loaded (candidates have no password since 11.2026; nothing compares one).
export const rowToUser = (r: any): IUser => {
  const user: any = {
    _id: r.id,
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phoneNumber: r.phone_number,
    dateOfBirth: r.date_of_birth,
    gender: r.gender,
    citySymbol: r.city_symbol,
    skills: r.skills ?? [],
    cvFileUrl: r.cv_file_url ?? '',
    hasAppliedToJob: r.has_applied_to_job,
    role: r.role,
    // Several roles per account (23.11.2026): the set; `role` is the highest of them (DB trigger).
    roles: rolesOf(r),
    // Roles an admin blocked (24.11.2026): kept in roles, but no gate or sign-in counts them (enums.ts usableRolesOf).
    blockedRoles: blockedOf(r),
    // A candidate of the existing site: 'mirror' = read-only here until the cutover (services/legacyCandidates.ts).
    legacyState: r.legacy_state ?? null,
  };
  return user as IUser;
};

/** The same user WITH the ID number: only for the candidate's own view, the staff candidates list (peopleHandover)
 *  and the Salesforce Contact. Never use it for anything an employer, a public route or the internal API returns. */
export const withIdNumber = (r: any): IUser => ({ ...rowToUser(r), idNumber: r.id_number ?? null });

/** The candidate's ID number (own view / Salesforce), or null. */
export const findIdNumber = async (userId: string): Promise<string | null> => {
  if (!isObjectId(userId)) return null;
  const r = await queryOne<{ id_number: string | null }>(`SELECT id_number FROM users WHERE id = $1`, [userId]);
  return r?.id_number ?? null;
};

// Fields a candidate may set at sign-up. `role` is never taken from the request
// (saving the whole body would let anyone register as admin).
// `ssoSub`: a candidate who signed up with "Continue with Google" (xhostd SSO): linked, no password.
// `msSub`: the same after "Continue with Microsoft" (users.ms_sub).
// `consent`: the sign-up form's answers (security/consent.ts) — the terms version accepted and the marketing box.
export const createUser = async (dto: CreateUserDto, opts: { ssoSub?: string; msSub?: string; consent: { marketing: boolean } }): Promise<IUser> => {
  const id = newObjectId();
  // The account and its consent record (consent_records: time, who, version) in one statement.
  const rows = await query(
    `WITH u AS (
       INSERT INTO users (id, first_name, last_name, email, phone_number, date_of_birth, gender, city_symbol,
                        password, skills, cv_file_url, has_applied_to_job, role, xhostd_sub, ms_sub,
                        terms_version, terms_accepted_at, marketing_consent, marketing_consent_at, id_number, custom_fields,
                        marketing_consent_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'user',$13,$16,$14,now(),$15,now(),$17,$18::jsonb,'signup') RETURNING *),
     c AS (INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
           SELECT 'user', u.id, u.terms_version, u.marketing_consent, 'signup' FROM u)
     SELECT * FROM u`,
    [
      // An optional phone that was left empty is stored as NULL (phone_number is unique; '' would collide).
      id, dto.firstName, dto.lastName, dto.email.toLowerCase(), dto.phoneNumber || null,
      dto.dateOfBirth ? new Date(dto.dateOfBirth) : null, dto.gender ?? '', dto.citySymbol ?? 0,
      '', (dto.skills ?? []).map(String).filter(isObjectId), dto.cvFileUrl ?? '', !!dto.hasAppliedToJob,
      opts.ssoSub ?? null, TERMS_VERSION, opts.consent.marketing, opts.msSub ?? null, dto.idNumber || null,
      JSON.stringify(mergeCustomValues({}, dto.customFields ?? {})),
    ]
  );
  return rowToUser(rows[0]);
};

const UPDATABLE: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phoneNumber: 'phone_number',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  citySymbol: 'city_symbol',
  skills: 'skills',
  cvFileUrl: 'cv_file_url',
  hasAppliedToJob: 'has_applied_to_job',
  idNumber: 'id_number',
};

/** `candidatesOnly`: the content managers' path — staff accounts can't be edited from the candidates screen
 *  (changing an admin's email there would let its password be reset to another inbox). */
export const updateUserById = async (userId: string, dto: UpdateUserDto, opts: { candidatesOnly?: boolean } = {}): Promise<IUser | null> => {
  if (!isObjectId(userId)) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [field, col] of Object.entries(UPDATABLE)) {
    let v = (dto as any)[field];
    if (v === undefined) continue;
    if (field === 'email') v = String(v).toLowerCase();
    if (field === 'dateOfBirth') v = v ? new Date(v) : null;
    if (field === 'idNumber' || field === 'phoneNumber') v = v || null; // cleared optional value → NULL
    if (field === 'skills') v = (Array.isArray(v) ? v : [v]).map(String).filter(isObjectId);
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  const onlyCandidates = opts.candidatesOnly ? ` AND 'user' = ANY(roles)` : '';
  if (!sets.length) {
    const u = await findUserById(userId);
    return u && (!opts.candidatesOnly || isCandidate(u)) ? u : null;
  }
  // A candidate of the existing site is read-only until the cutover (db.ts users_legacy_guard is the backstop).
  if (await queryOne(`SELECT 1 FROM users WHERE id = $1 AND legacy_state = 'mirror'`, [userId])) throw new CandidateReadOnlyError();
  vals.push(userId);
  const rows = await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}${onlyCandidates} RETURNING *`, vals);
  return rows[0] ? rowToUser(rows[0]) : null;
};

export const findAll = async (f: usersFilter): Promise<{ users: IUser[]; total: number }> => {
  const page = Math.max(1, Number(f?.page || 1));
  // The admin screen asks for 9; 50 is the most one request may take (it was 500).
  const limit = Math.min(50, Math.max(1, Number(f?.limit || 40)));
  const params: any[] = [];
  // Candidates only: everyone holding the candidate role (also someone who is staff or an employer too: the same
  // hand-overs and limits as any candidate). Staff-only and employer-only accounts are never listed here.
  const where: string[] = [`'user' = ANY(u.roles)`];

  const input = f.inputValue?.trim();
  if (input) {
    params.push(`%${escapeLike(input)}%`);
    const p = `$${params.length}`;
    where.push(`(u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone_number ILIKE ${p}
                 OR (u.first_name || ' ' || u.last_name) ILIKE ${p})`);
  }
  if (String(f.hasCv) === 'true') where.push(`u.cv_file_url <> ''`);
  if (f.hasApplied === true) where.push(`u.has_applied_to_job = true`);
  if (isMarketingStatus(f.marketing)) where.push(`(${STATUS_SQL[f.marketing]})`);

  const col = f.sortField ? SORT_COLUMNS[f.sortField] : undefined;
  const order = col && f.sortOrder ? `${col} ${String(f.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'}, u.id DESC` : 'u.id DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count, signupDefs] = await Promise.all([
    query(
      `SELECT u.*, l.city AS l_city, l.district AS l_district, l.city_symbol AS l_city_symbol,
         COALESCE((SELECT jsonb_object_agg(s.id, s.name) FROM skills s WHERE s.id = ANY(u.skills)), '{}'::jsonb) AS skills_map,
         COALESCE((SELECT jsonb_object_agg(j.id, j.title) FROM job_applications a JOIN jobs j ON j.id = a.job_id
                   WHERE a.user_id = u.id), '{}'::jsonb) AS applications_map,
         COALESCE((SELECT jsonb_agg(a.job_id) FROM job_applications a WHERE a.user_id = u.id AND a.cv_file_url <> ''), '[]'::jsonb) AS application_cv_jobs
       FROM users u LEFT JOIN locations l ON l.city_symbol = u.city_symbol
       ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    ),
    queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users u ${whereSql}`, params),
    definitionsOf('signup'),
  ]);

  const users = rows.map((r) => {
    // The staff candidates list (GET /api/users, through peopleHandover): with the ID number.
    const u: any = withIdNumber(r);
    if (r.l_city != null) u.location = { _id: String(r.l_city_symbol), citySymbol: r.l_city_symbol, city: r.l_city, district: r.l_district };
    u.requiredSkillsDetails = r.skills_map ?? {};
    u.jobApplicationsToDisplay = r.applications_map ?? {};
    // Which of those applications were sent with a CV (job ids): staff open it through the CV hand-over.
    u.applicationCvJobs = r.application_cv_jobs ?? [];
    // Answers to the added sign-up fields, with their labels (this list only; never employers or the public).
    u.extraDetails = shownValues(signupDefs, r.custom_fields);
    // Marketing mail state (this list only; never employers or the public).
    u.marketing = { status: marketingStatus(r.marketing_consent, r.marketing_optout_at), at: r.marketing_optout_at ?? r.marketing_consent_at ?? null };
    return u as IUser;
  });
  return { users, total: Number(count?.count ?? 0) };
};

export const findUserById = async (userId: string): Promise<IUser | null> => {
  if (!isObjectId(userId)) return null;
  const row = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
  return row ? rowToUser(row) : null;
};

export const findUserByEmail = async (email: string): Promise<IUser | null> => {
  if (!email) return null;
  const row = await queryOne(`SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email)]);
  return row ? rowToUser(row) : null;
};

export const findUserByPhoneNumber = async (phoneNumber: string): Promise<IUser | null> => {
  const row = await queryOne(`SELECT * FROM users WHERE phone_number = $1`, [String(phoneNumber)]);
  return row ? rowToUser(row) : null;
};


/** Not used by routes: staff roles change only through the staff users screen (staffController). Makes `role` the
 *  account's only role (scripts). */
export const setUserRole = async (email: string, role: UserRole): Promise<boolean> => {
  const rows = await query(`UPDATE users SET roles = ARRAY[$1]::text[] WHERE lower(email) = lower($2) RETURNING id`, [role, email]);
  return rows.length > 0;
};

// ---- xhostd SSO ("Continue with Google") ------------------------------------------------
export const findUserBySsoSub = async (sub: string): Promise<IUser | null> => {
  if (!sub) return null;
  const row = await queryOne(`SELECT * FROM users WHERE xhostd_sub = $1`, [String(sub)]);
  return row ? rowToUser(row) : null;
};

/** Links an SSO identity to an account that has none yet (never overwrites another link). */
/**
 * After SSO was linked to an existing CANDIDATE account by email (staff have no password sign-in anyway): clears its password and closes every earlier session
 * (refresh tokens disabled, access tokens issued before this second refused). Returns true when there was a
 * password. Every token issued up to this second is refused; the session made right after still works through its
 * new refresh token (the access cookie is re-issued from it until the second has passed), as after a password reset.
 */
export const clearPasswordAfterSsoLink = async (userId: string): Promise<boolean> => {
  const rows = await query(
    `UPDATE users SET password = '', sessions_revoked_at = now(), updated_at = now()
      WHERE id = $1 AND 'user' = ANY(roles) AND password IS NOT NULL AND password <> '' RETURNING id`, [userId]);
  if (!rows.length) return false;
  await query(`UPDATE tokens SET disabled = true WHERE user_id = $1`, [userId]); // refresh and reset tokens
  return true;
};

export const linkSsoSub = async (userId: string, sub: string): Promise<boolean> => {
  const rows = await query(`UPDATE users SET xhostd_sub = $1, updated_at = now() WHERE id = $2 AND xhostd_sub IS NULL RETURNING id`, [sub, userId]);
  return rows.length > 0;
};


// ---- "Continue with Microsoft" (candidates only) --------------------------------------
export const findUserByMsSub = async (key: string): Promise<IUser | null> => {
  if (!key) return null;
  const row = await queryOne(`SELECT * FROM users WHERE ms_sub = $1`, [String(key)]);
  return row ? rowToUser(row) : null;
};

/** Links a Microsoft identity to an account holding a CANDIDATE or EMPLOYER role that has none yet (never overwrites;
 *  a Microsoft session never carries a staff role, security/pure.ts effectiveRoles). */
export const linkMsSub = async (userId: string, key: string): Promise<boolean> => {
  const rows = await query(`UPDATE users SET ms_sub = $1, updated_at = now() WHERE id = $2 AND ms_sub IS NULL AND roles && ARRAY['user', 'employer']::text[] RETURNING id`, [key, userId]);
  return rows.length > 0;
};

/** The signed-in candidate's own record (personal area): never staff, never someone else (id from the session). */
export const updateOwnCandidateProfile = (userId: string, dto: UpdateUserDto) => updateUserById(userId, dto, { candidatesOnly: true });

/** How the account signs in (personal area). Candidates have no password: Google / Microsoft (ssoLinked) and/or a code by email. */
export const signInFacts = async (userId: string): Promise<{ ssoLinked: boolean }> => {
  const r = await queryOne(`SELECT (xhostd_sub IS NOT NULL OR ms_sub IS NOT NULL) AS sso FROM users WHERE id = $1`, [userId]);
  return { ssoLinked: !!r?.sso };
};

// ---- consent (security/consent.ts) ----

export interface UserConsent {
  termsVersion: string | null; termsAcceptedAt: Date | null; marketingConsent: boolean | null; marketingConsentAt: Date | null;
  /** Set while the address is on the removal list (a removal always wins over an earlier "yes"). */
  marketingOptoutAt: Date | null;
}

export const getConsent = async (userId: string): Promise<UserConsent | null> => {
  const r = await queryOne(`SELECT terms_version, terms_accepted_at, marketing_consent, marketing_consent_at, marketing_optout_at FROM users WHERE id = $1`, [userId]);
  if (!r) return null;
  return {
    termsVersion: r.terms_version ?? null, termsAcceptedAt: r.terms_accepted_at ?? null, marketingConsent: r.marketing_consent ?? null,
    marketingConsentAt: r.marketing_consent_at ?? null, marketingOptoutAt: r.marketing_optout_at ?? null,
  };
};

/** Stores what was answered: `terms` true = the current version accepted now; `marketing` true/false = answered now.
 * `source`: where it was answered ('apply', 'personal_area'); each answer is also kept in consent_records. */
export const recordConsent = async (userId: string, c: { terms?: boolean; marketing?: boolean | null }, source = 'apply'): Promise<void> => {
  const sets: string[] = [];
  const vals: unknown[] = [userId, c.terms === true ? TERMS_VERSION : null, typeof c.marketing === 'boolean' ? c.marketing : null, source];
  if (c.terms === true) sets.push('terms_version = $2', 'terms_accepted_at = now()');
  // A marketing answer here is the candidate's own (signed in); a "yes" also clears a removal (security/marketing.ts).
  if (typeof c.marketing === 'boolean') sets.push('marketing_consent = $3', 'marketing_consent_at = now()', 'marketing_consent_source = $4');
  if (c.marketing === true) sets.push('marketing_optout_at = NULL');
  if (!sets.length) return;
  if (c.marketing === true) await ownYesClearsRemoval(userId);
  await query(
    `WITH u AS (UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id)
     INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
     SELECT 'user', u.id, $2::text, $3::boolean, $4 FROM u`, vals);
};

/**
 * Several roles per account (owner, 23.11.2026): adds the CANDIDATE role to an existing account (staff or employer)
 * with the candidate's details (already checked by checkProfile, the same rules as every sign-up) and the consent
 * given on that form (users + a consent_records row in the same statement). Email and sign-in stay the account's.
 * Returns the user, or null when the account already holds the role or is gone / deactivated. A phone number
 * someone else uses → the driver's unique violation (23505), answered like a sign-up (us3).
 */
export const addCandidateRole = async (
  userId: string, v: { firstName: string; lastName: string; phoneNumber?: string | null; dateOfBirth?: string | Date | null;
    gender?: string; citySymbol?: number; idNumber?: string | null; skills?: string[] },
  consent: { marketing: boolean },
): Promise<IUser | null> => {
  const rows = await query(
    `WITH u AS (
       UPDATE users SET roles = array_append(roles, 'user'), first_name = $2, last_name = $3, phone_number = $4,
              date_of_birth = $5, gender = $6, city_symbol = $7, id_number = $8, skills = $9,
              terms_version = $10, terms_accepted_at = now(), marketing_consent = $11, marketing_consent_at = now(),
              marketing_consent_source = 'candidate_role_added', updated_at = now()
        WHERE id = $1 AND deactivated_at IS NULL AND NOT ('user' = ANY(roles)) RETURNING *),
     c AS (INSERT INTO consent_records (subject_kind, subject_id, privacy_version, marketing, source)
           SELECT 'user', u.id, u.terms_version, u.marketing_consent, 'candidate_role_added' FROM u)
     SELECT * FROM u`,
    [userId, v.firstName, v.lastName, v.phoneNumber || null, v.dateOfBirth ? new Date(v.dateOfBirth) : null, v.gender ?? '',
      v.citySymbol ?? 0, v.idNumber || null, (v.skills ?? []).map(String).filter(isObjectId), TERMS_VERSION, consent.marketing]);
  return rows[0] ? rowToUser(rows[0]) : null;
};
