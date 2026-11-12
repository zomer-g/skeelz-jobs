import { CreateUserDto } from "../dto/createUserDto.js";
import { IUser } from "../models/schemas/user.js";
import { UpdateUserDto } from "../dto/updateUserDto.js";
import { usersFilter } from "../models/interfaces/general.interface.js";
import { escapeLike, query, queryOne } from "../config/db.js";
import { isObjectId, newObjectId } from "../utils/ids.js";
import { UserRole } from "../models/enums.js";

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

export const rowToUser = (r: any, opts: { withPassword?: boolean } = {}): IUser => {
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
  };
  if (opts.withPassword) user.password = r.password;
  return user as IUser;
};

// Fields a candidate may set at sign-up. `role` is never taken from the request
// (saving the whole body would let anyone register as admin).
// `ssoSub`: a candidate who signed up with "Continue with Google" (xhostd SSO): linked, no password.
export const createUser = async (dto: CreateUserDto, opts: { ssoSub?: string } = {}): Promise<IUser> => {
  const id = newObjectId();
  const rows = await query(
    `INSERT INTO users (id, first_name, last_name, email, phone_number, date_of_birth, gender, city_symbol,
                        password, skills, cv_file_url, has_applied_to_job, role, xhostd_sub)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'user',$13) RETURNING *`,
    [
      id, dto.firstName, dto.lastName, dto.email.toLowerCase(), dto.phoneNumber,
      dto.dateOfBirth ? new Date(dto.dateOfBirth) : null, dto.gender ?? '', dto.citySymbol,
      dto.password, (dto.skills ?? []).map(String).filter(isObjectId), dto.cvFileUrl ?? '', !!dto.hasAppliedToJob,
      opts.ssoSub ?? null,
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
    if (field === 'skills') v = (Array.isArray(v) ? v : [v]).map(String).filter(isObjectId);
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  const onlyCandidates = opts.candidatesOnly ? ` AND role = 'user'` : '';
  if (!sets.length) {
    const u = await findUserById(userId);
    return u && (!opts.candidatesOnly || u.role === UserRole.USER) ? u : null;
  }
  vals.push(userId);
  const rows = await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}${onlyCandidates} RETURNING *`, vals);
  return rows[0] ? rowToUser(rows[0]) : null;
};

export const findAll = async (f: usersFilter): Promise<{ users: IUser[]; total: number }> => {
  const page = Math.max(1, Number(f?.page || 1));
  // The admin screen asks for 9; 50 is the most one request may take (it was 500).
  const limit = Math.min(50, Math.max(1, Number(f?.limit || 40)));
  const params: any[] = [];
  // Candidates only: staff accounts are managed by admins (staff users screen), not listed here.
  const where: string[] = [`u.role = 'user'`];

  const input = f.inputValue?.trim();
  if (input) {
    params.push(`%${escapeLike(input)}%`);
    const p = `$${params.length}`;
    where.push(`(u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone_number ILIKE ${p}
                 OR (u.first_name || ' ' || u.last_name) ILIKE ${p})`);
  }
  if (String(f.hasCv) === 'true') where.push(`u.cv_file_url <> ''`);
  if (f.hasApplied === true) where.push(`u.has_applied_to_job = true`);

  const col = f.sortField ? SORT_COLUMNS[f.sortField] : undefined;
  const order = col && f.sortOrder ? `${col} ${String(f.sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC'}, u.id DESC` : 'u.id DESC';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, count] = await Promise.all([
    query(
      `SELECT u.*, l.city AS l_city, l.district AS l_district, l.city_symbol AS l_city_symbol,
         COALESCE((SELECT jsonb_object_agg(s.id, s.name) FROM skills s WHERE s.id = ANY(u.skills)), '{}'::jsonb) AS skills_map,
         COALESCE((SELECT jsonb_object_agg(j.id, j.title) FROM job_applications a JOIN jobs j ON j.id = a.job_id
                   WHERE a.user_id = u.id), '{}'::jsonb) AS applications_map
       FROM users u LEFT JOIN locations l ON l.city_symbol = u.city_symbol
       ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    ),
    queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users u ${whereSql}`, params),
  ]);

  const users = rows.map((r) => {
    const u: any = rowToUser(r);
    if (r.l_city != null) u.location = { _id: String(r.l_city_symbol), citySymbol: r.l_city_symbol, city: r.l_city, district: r.l_district };
    u.requiredSkillsDetails = r.skills_map ?? {};
    u.jobApplicationsToDisplay = r.applications_map ?? {};
    return u as IUser;
  });
  return { users, total: Number(count?.count ?? 0) };
};

export const findUserById = async (userId: string): Promise<IUser | null> => {
  if (!isObjectId(userId)) return null;
  const row = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
  return row ? rowToUser(row, { withPassword: true }) : null;
};

export const findUserByEmail = async (email: string): Promise<IUser | null> => {
  if (!email) return null;
  const row = await queryOne(`SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email)]);
  return row ? rowToUser(row, { withPassword: true }) : null;
};

export const findUserByPhoneNumber = async (phoneNumber: string): Promise<IUser | null> => {
  const row = await queryOne(`SELECT * FROM users WHERE phone_number = $1`, [String(phoneNumber)]);
  return row ? rowToUser(row) : null;
};

export const findUserByEmailWithPassword = findUserByEmail;

export const updateUserPassword = async (userID: string, hashedPassword: string): Promise<void> => {
  await query(`UPDATE users SET password = $1, updated_at = now() WHERE id = $2`, [hashedPassword, String(userID)]);
};

/** Not used by routes: roles change only through the staff users screen (staffController). */
export const setUserRole = async (email: string, role: UserRole): Promise<boolean> => {
  const rows = await query(`UPDATE users SET role = $1 WHERE lower(email) = lower($2) RETURNING id`, [role, email]);
  return rows.length > 0;
};

// ---- xhostd SSO ("Continue with Google") ------------------------------------------------
export const findUserBySsoSub = async (sub: string): Promise<IUser | null> => {
  if (!sub) return null;
  const row = await queryOne(`SELECT * FROM users WHERE xhostd_sub = $1`, [String(sub)]);
  return row ? rowToUser(row) : null;
};

/** Links an SSO identity to an account that has none yet (never overwrites another link). */
export const linkSsoSub = async (userId: string, sub: string): Promise<boolean> => {
  const rows = await query(`UPDATE users SET xhostd_sub = $1, updated_at = now() WHERE id = $2 AND xhostd_sub IS NULL RETURNING id`, [sub, userId]);
  return rows.length > 0;
};


/** The signed-in candidate's own record (personal area): never staff, never someone else (id from the session). */
export const updateOwnCandidateProfile = (userId: string, dto: UpdateUserDto) => updateUserById(userId, dto, { candidatesOnly: true });

/** How the account signs in (personal area: email read-only, password shown or not). */
export const signInFacts = async (userId: string): Promise<{ hasPassword: boolean; ssoLinked: boolean }> => {
  const r = await queryOne(`SELECT (password IS NOT NULL AND password <> '') AS has_password, (xhostd_sub IS NOT NULL) AS sso FROM users WHERE id = $1`, [userId]);
  return { hasPassword: !!r?.has_password, ssoLinked: !!r?.sso };
};
