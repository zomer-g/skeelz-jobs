/* ============================================================================
 *  A CV of the existing site's candidate, kept in Salesforce (owner,
 *  20.11.2026: not copied, opened only when needed). cv_file_url holds a
 *  pointer ('sf:<ContentVersion id>', written only by the candidates mirror);
 *  s3Service.getStoredFile opens it from here, so every way to open a CV — the
 *  staff (cvHandover), the candidate's own download, an employer's forwarded
 *  applicant — goes through the same hand-overs, limits and strict log as any
 *  other CV. The ONE read of Salesforce on a request path (CLAUDE.md): GET only,
 *  one file, nothing stored here, nothing written there.
 * ========================================================================== */
import { Readable } from 'stream';
import { AxiosError } from 'axios';
import appConfig from '../config/appConfig.js';
import { queryOne } from '../config/db.js';
import { sfRequest } from '../config/salesforceConfig.js';
import { FilesErrorCodes, FilesErrorMessages } from '../i18n/i18n.js';
import { isSfCvKey, sfCvFileName } from './legacyCandidatesPure.js';

export { isSfCvKey };

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const MAX_BYTES = 15 * 1024 * 1024;

type Meta = { versionId: string; title: string; ext: string; at: string };

/** What the mirror stored about this file (only a pointer some candidate row holds is ever opened). */
const metaOf = async (key: string): Promise<Meta | null> => {
  const r = await queryOne<{ legacy_cv: Meta | null }>(
    `SELECT legacy_cv FROM users WHERE cv_file_url = $1 AND legacy_cv IS NOT NULL LIMIT 1`, [key]);
  if (r?.legacy_cv) return r.legacy_cv;
  // An application sent after the cutover with that profile CV keeps the pointer even if the profile changed since.
  const a = await queryOne<{ legacy_cv: Meta | null }>(
    `SELECT u.legacy_cv FROM job_applications j JOIN users u ON u.id = j.user_id WHERE j.cv_file_url = $1 AND u.legacy_cv IS NOT NULL LIMIT 1`, [key]);
  return a?.legacy_cv ?? { versionId: key.slice(3), title: 'cv', ext: 'pdf', at: '' };
};

export const sfCvInfo = async (key: string): Promise<{ fileName: string; uploadedAt: Date | null } | null> => {
  if (!isSfCvKey(key)) return null;
  const m = await metaOf(key);
  if (!m) return null;
  return { fileName: sfCvFileName(m), uploadedAt: m.at ? new Date(m.at) : null };
};

/** Opens the file from Salesforce (read-only). Salesforce off → the file is not available (503-like code). */
export const openSfCv = async (key: string): Promise<{ stream: Readable; contentType: string; contentLength?: number; fileName: string }> => {
  if (!isSfCvKey(key)) throw new AxiosError(FilesErrorMessages.INVALID_S3_KEY_FORMAT, FilesErrorCodes.INVALID_S3_KEY_FORMAT);
  if (!appConfig.salesforce.enableSalesforce) {
    throw new AxiosError('קורות החיים שמורים במערכת ניהול הקשרים, שאינה זמינה כרגע.', 'cv_in_salesforce_unavailable');
  }
  const meta = (await metaOf(key))!;
  const versionId = key.slice(3);
  try {
    const info = await sfRequest<{ FileExtension?: string; ContentSize?: number; Title?: string }>(
      'GET', `sobjects/ContentVersion/${versionId}?fields=FileExtension,ContentSize,Title`);
    const ext = String(info?.FileExtension ?? meta.ext).toLowerCase();
    if (!CONTENT_TYPES[ext]) throw Object.assign(new Error('not a CV file'), { code: 'not_cv' });
    if (Number(info?.ContentSize ?? 0) > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'too_large' });
    const stream = await sfRequest<Readable>('GET', `sobjects/ContentVersion/${versionId}/VersionData`, undefined, { responseType: 'stream' });
    return {
      stream, contentType: CONTENT_TYPES[ext], contentLength: Number(info?.ContentSize) || undefined,
      fileName: sfCvFileName({ title: String(info?.Title ?? meta.title), ext }),
    };
  } catch {
    throw new AxiosError(FilesErrorMessages.FAILED_TO_FETCH_FILE_S3, FilesErrorCodes.FAILED_TO_FETCH_FILE_S3);
  }
};
