import { NextFunction, Request, Response } from 'express';
import { AxiosError, isAxiosError } from 'axios';
import { getCvUploadInfo, getStoredFile } from '../services/s3Service.js';
import { getUserById } from '../services/userService.js';
import { AuthErrorCodes, AuthErrorMessages, FilesErrorCodes, FilesErrorMessages } from '../i18n/i18n.js';

/*
 * The signed-in candidate's own profile CV. There is no user id in these
 * routes: the CV is always the one on the caller's own profile, so nobody can
 * reach another person's file through them.
 */

const ownCvKey = async (req: Request): Promise<string> => {
  const userID = req.authJwtPayload?.userID;
  if (!userID) throw new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED);
  const user = await getUserById(userID);
  if (!user) throw new AxiosError(AuthErrorMessages.UNAUTHORIZED, AuthErrorCodes.UNAUTHORIZED);
  return user.cvFileUrl || '';
};

// GET /users/me/cv -> { cv: { fileName, uploadedAt } | null }
export const getMyCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const info = await getCvUploadInfo(await ownCvKey(req));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ data: { cv: info ? { fileName: info.fileName, uploadedAt: info.uploadedAt } : null } });
  } catch (error) {
    if (isAxiosError(error)) return next(error);
    next(new AxiosError(FilesErrorMessages.FILE_FETCH_FAILED, FilesErrorCodes.FILE_FETCH_FAILED));
  }
};

// GET /users/me/cv/file -> the file itself (download)
export const downloadMyCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = await ownCvKey(req);
    if (!key) return res.status(404).json({ message: 'No CV on file' });
    const file = await getStoredFile(key);
    res.setHeader('Content-Type', file.contentType);
    if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    file.stream.on('error', (error) => {
      console.error('Error reading stored file:', (error as Error).message);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    file.stream.pipe(res);
  } catch (error) {
    if (isAxiosError(error)) return next(error);
    next(new AxiosError(FilesErrorMessages.FILE_FETCH_FAILED, FilesErrorCodes.FILE_FETCH_FAILED));
  }
};
