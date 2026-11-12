/* ============================================================================
 *  CV storage on the xhostd Blob (S3-compatible, private bucket).
 *
 *  xhostd injects S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID /
 *  S3_SECRET_ACCESS_KEY / S3_REGION at runtime. Objects are private: the only
 *  way to read one is GET /api/files/:userId, which is admin-only.
 *
 *  Every file is checked here before it is stored (magic bytes + extension,
 *  PDF re-saved with pdf-lib, DOCX macro check). Keys live under `post-scan/`
 *  so keys stored by the earlier system keep working.
 *
 *  Local development without S3_* env: files go to server/.local-blob/
 *  (never in production).
 * ========================================================================== */
import { AxiosError } from "axios";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { FilesErrorCodes, FilesErrorMessages } from "../i18n/i18n.js";
import { validateAndSanitizeFile } from "./fileProcessingService.js";
import { S3Folder } from "../models/enums.js";
import { isEnglishString } from "../utils/utils.js";
import { query, queryOne } from "../config/db.js";
import { BlobClient } from "./blobClient.js";

const BUCKET = process.env.S3_BUCKET || '';
const useS3 = !!(process.env.S3_ENDPOINT && BUCKET);
const LOCAL_DIR = path.resolve(process.cwd(), '.local-blob');

if (!useS3 && process.env.NODE_ENV === 'production') {
  console.warn('[storage] S3_* env is missing: CV uploads will fail');
}

const s3 = useS3
  ? new BlobClient({
      endpoint: process.env.S3_ENDPOINT || '',
      bucket: BUCKET,
      region: process.env.S3_REGION || 'auto',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    })
  : null;

const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/;

const sanitizeFileName = (fileName: string) => {
  const base = path.basename(String(fileName)).replace(/[\\/]/g, '');
  const name = isEnglishString(base) ? base.toLowerCase() : base;
  return name.replace(/ /g, "_");
};

/** Accepts "token/name", "post-scan/token/name" or "/post-scan/token/name" and returns the canonical key, or null. */
export const normalizeCvKey = (value: string | undefined | null): string | null => {
  if (!value || typeof value !== 'string') return null;
  const rest = value.replace(/^\/+/, '').replace(new RegExp(`^${S3Folder.POST_SCAN}`), '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const [token, name] = parts;
  if (!TOKEN_RE.test(token) || !name || name.includes('..') || name !== sanitizeFileName(name)) return null;
  return `${S3Folder.POST_SCAN}${token}/${name}`;
};

const localPath = (key: string) => {
  const p = path.resolve(LOCAL_DIR, key);
  if (!p.startsWith(LOCAL_DIR + path.sep)) throw new Error('bad key');
  return p;
};

const putObject = async (key: string, body: Buffer, contentType: string) => {
  if (s3) {
    await s3.put(key, body, contentType);
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('storage not configured');
  const p = localPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
};

const deleteObject = async (key: string) => {
  if (s3) {
    await s3.delete(key);
    return;
  }
  await fs.rm(localPath(key), { force: true });
};

export const uploadFileToS3 = async (fileBufferBefore: Buffer, fileType: string, fileName: string, mimeType: string, token: string) => {
  if (!TOKEN_RE.test(token || '')) {
    throw new AxiosError(FilesErrorMessages.INVALID_S3_KEY_FORMAT, FilesErrorCodes.INVALID_S3_KEY_FORMAT);
  }
  const { fileBuffer, sanitized } = await validateAndSanitizeFile(fileBufferBefore, fileType);
  if (!sanitized || !fileBuffer) {
    throw new AxiosError(FilesErrorMessages.FILE_UPLOAD_FAILED, FilesErrorCodes.FILE_UPLOAD_FAILED);
  }
  const key = `${S3Folder.POST_SCAN}${token}/${sanitizeFileName(fileName)}`;
  // One upload per token; a token that already belongs to someone cannot be reused.
  const existing = await queryOne<{ claimed_by: string | null }>(`SELECT claimed_by FROM cv_uploads WHERE key LIKE $1 LIMIT 1`, [`${S3Folder.POST_SCAN}${token}/%`]);
  if (existing?.claimed_by) {
    throw new AxiosError(FilesErrorMessages.FILE_UPLOAD_FAILED, FilesErrorCodes.FILE_UPLOAD_FAILED);
  }
  try {
    await putObject(key, fileBuffer, mimeType);
    await query(`INSERT INTO cv_uploads (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [key]);
    return { fileUrl: key, fileName };
  } catch (error) {
    console.error('[storage] upload failed', (error as Error).message);
    throw new AxiosError(FilesErrorMessages.FAILED_TO_UPLOAD_FILE_S3, FilesErrorCodes.FAILED_TO_UPLOAD_FILE_S3);
  }
};

/**
 * Attaches a pending upload to an owner (user id or guest application id).
 * Returns the canonical key, or '' when the value is empty/unknown/already taken.
 */
export const claimCvUpload = async (value: string | undefined | null, ownerId: string): Promise<string> => {
  const key = normalizeCvKey(value);
  if (!key) return '';
  const rows = await query(`UPDATE cv_uploads SET claimed_by = $2 WHERE key = $1 AND claimed_by IS NULL RETURNING key`, [key, ownerId]);
  return rows.length ? key : '';
};

/** Anonymous cancel of an upload the visitor just made (only while nobody owns it). */
export const deletePendingUpload = async (value: string): Promise<boolean> => {
  const key = normalizeCvKey(value);
  if (!key) return false;
  const rows = await query(`DELETE FROM cv_uploads WHERE key = $1 AND claimed_by IS NULL RETURNING key`, [key]);
  if (!rows.length) return false;
  await deleteObject(key);
  return true;
};

export interface StoredFile {
  stream: Readable;
  contentType: string;
  contentLength?: number;
  fileName: string;
}

export const getStoredFile = async (fileKey: string): Promise<StoredFile> => {
  const key = normalizeCvKey(fileKey);
  if (!key) throw new AxiosError(FilesErrorMessages.INVALID_S3_KEY_FORMAT, FilesErrorCodes.INVALID_S3_KEY_FORMAT);
  const fileName = key.split('/').pop() || 'cv-file';
  try {
    if (s3) {
      const res = await s3.get(key);
      return { stream: res.body, contentType: res.contentType || 'application/octet-stream', contentLength: res.contentLength, fileName };
    }
    const buf = await fs.readFile(localPath(key));
    const contentType = fileName.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return { stream: Readable.from(buf), contentType, contentLength: buf.length, fileName };
  } catch (error) {
    throw new AxiosError(FilesErrorMessages.FAILED_TO_FETCH_FILE_S3, FilesErrorCodes.FAILED_TO_FETCH_FILE_S3);
  }
};

/**
 * Deletes uploads that nobody attached (an abandoned sign-up/apply form, or
 * abuse of the anonymous upload) after CV_PENDING_TTL_HOURS (default 24).
 * The row is removed first, only while still unclaimed, so a CV that is being
 * attached at the same moment is never deleted. Returns how many were removed.
 */
export const purgeStaleUploads = async (): Promise<number> => {
  const hours = Math.max(1, Number(process.env.CV_PENDING_TTL_HOURS) || 24);
  const rows = await query<{ key: string }>(
    `DELETE FROM cv_uploads WHERE key IN (
       SELECT key FROM cv_uploads WHERE claimed_by IS NULL AND created_at < now() - make_interval(hours => $1) LIMIT 500
     ) AND claimed_by IS NULL RETURNING key`,
    [hours]
  );
  for (const { key } of rows) {
    await deleteObject(key).catch((e) => console.error('[storage] purge: could not delete an object', (e as Error).message));
  }
  return rows.length;
};

/**
 * Name and upload date of a stored CV, for showing it to its owner.
 * uploadedAt is null for CVs imported from the old system (no upload record).
 */
export const getCvUploadInfo = async (value: string | undefined | null): Promise<{ fileName: string; uploadedAt: Date | null } | null> => {
  const key = normalizeCvKey(value);
  if (!key) return null;
  const row = await queryOne<{ created_at: Date }>(`SELECT created_at FROM cv_uploads WHERE key = $1`, [key]);
  return { fileName: key.split('/').pop() || 'cv-file', uploadedAt: row?.created_at ?? null };
};

/** Kept for the Salesforce CV upload. */
export const getFileFromS3 = async (fileKey: string): Promise<Readable> => (await getStoredFile(fileKey)).stream;

/** Admin delete of a stored CV (any state). */
export async function deleteFileAndFolderInS3(cvPath: string): Promise<void> {
  const key = normalizeCvKey(cvPath);
  if (!key) throw new AxiosError(FilesErrorMessages.INVALID_S3_KEY_FORMAT, FilesErrorCodes.INVALID_S3_KEY_FORMAT);
  try {
    await deleteObject(key);
    await query(`DELETE FROM cv_uploads WHERE key = $1`, [key]);
  } catch (error) {
    throw new AxiosError(FilesErrorMessages.FAILED_TO_DELETE_FILE_OR_FOLDER_S3, FilesErrorCodes.FAILED_TO_DELETE_FILE_OR_FOLDER_S3);
  }
}
