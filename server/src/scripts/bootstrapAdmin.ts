/* ============================================================================
 *  Creates the first admin account from env, at boot.
 *
 *    ADMIN_EMAIL             the admin's email — the Google account they sign in with
 *                            ("Continue with Google" = xhostd SSO; staff have no password sign-in)
 *    ADMIN_INITIAL_PASSWORD  optional, not needed: staff can't sign in with a password. Only
 *                            local tests set it (to prove a staff password is refused).
 *
 *  If the account already exists it is made admin (a break-glass: ADMIN_EMAIL is
 *  admin again after every boot). Otherwise it is created, without a password, and
 *  linked to the Google identity at its first SSO sign-in (matched by email).
 *  Other staff are managed in /users-management.
 *
 *  Local development / tests only (never set on prod):
 *    CONTENT_MANAGER_EMAIL / CONTENT_MANAGER_INITIAL_PASSWORD  creates a content
 *    manager when the account doesn't exist yet (an existing one is left alone).
 * ========================================================================== */
import { pathToFileURL } from 'url';
import { migrate, pool, query, queryOne } from '../config/db.js';
import { hashPassword } from '../services/hashService.js';
import { newObjectId } from '../utils/ids.js';

export const bootstrapAdmin = async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_INITIAL_PASSWORD || '';
  if (!email) return;
  await migrate();
  const existing = await queryOne<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
  if (existing) {
    // Promoting a non-staff account clears its password: staff sign in only with SSO, and a candidate's old
    // password (which someone else may know) must not stay on an admin account.
    await query(
      `UPDATE users SET password = CASE WHEN role IN ('admin', 'content_manager', 'placement_coordinator') THEN password ELSE '' END,
                        sessions_revoked_at = CASE WHEN role IN ('admin', 'content_manager', 'placement_coordinator') THEN sessions_revoked_at ELSE now() END,
                        role = 'admin' WHERE id = $1`, [existing.id]);
    if (password && process.env.ADMIN_RESET_PASSWORD === 'true') {
      await query(`UPDATE users SET password = $1 WHERE id = $2`, [await hashPassword(password), existing.id]);
      console.log('[admin] password reset');
    }
    console.log('[admin] admin role ensured');
    return;
  }
  // Staff sign in only with xhostd SSO, so no password is needed. A given one is stored only if it is long
  // enough (local tests use it to check that a staff password is refused); it never signs staff in.
  if (password && password.length < 12) console.warn('[admin] ADMIN_INITIAL_PASSWORD shorter than 12 characters: ignored');
  const hashed = password.length >= 12 ? await hashPassword(password) : '';
  await query(
    `INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, role, has_applied_to_job)
     VALUES ($1, 'Admin', 'SKEELZ', $2, $3, '', -1, $4, 'admin', false)`,
    [newObjectId(), email, `admin-${Date.now()}`, hashed]
  );
  console.log('[admin] admin account created (signs in with "Continue with Google")');
};

export const bootstrapContentManager = async () => {
  const email = (process.env.CONTENT_MANAGER_EMAIL || '').trim().toLowerCase();
  const password = process.env.CONTENT_MANAGER_INITIAL_PASSWORD || '';
  if (!email) return;
  if (process.env.DEV_MODE !== 'true') {
    console.warn('[staff] CONTENT_MANAGER_EMAIL works only with DEV_MODE=true: ignored');
    return;
  }
  await migrate();
  if (await queryOne(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])) return;
  if (password.length < 12) {
    console.warn('[staff] CONTENT_MANAGER_INITIAL_PASSWORD missing or shorter than 12 characters: not created');
    return;
  }
  await query(
    `INSERT INTO users (id, first_name, last_name, email, phone_number, gender, city_symbol, password, role, has_applied_to_job)
     VALUES ($1, 'Content', 'Manager', $2, $3, '', -1, $4, 'content_manager', false)`,
    [newObjectId(), email, `staff-${Date.now()}`, await hashPassword(password)]
  );
  console.log('[staff] content manager account created');
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapAdmin()
    .then(() => bootstrapContentManager())
    .catch((e) => { console.error('[admin] failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
