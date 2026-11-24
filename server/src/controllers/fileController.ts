import { NextFunction, Request, Response } from "express";
import { UpdateUserDto } from "../dto/updateUserDto.js";
import { deletePendingUpload, getStoredFile, uploadFileToS3 } from "../services/s3Service.js";
import * as userDAL from "../dal/userDAL.js";
import { UserRole, canManageContent, isCandidate } from "../models/enums.js";
import { AuthErrorCodes, AuthErrorMessages } from "../i18n/i18n.js";
import { fetchCvUrlByUserId } from "../services/fileProcessingService.js";
import { getFileType } from "../utils/pdfValidationUtils.js";
import { AxiosError, isAxiosError } from "axios";
import { FilesErrorCodes, FilesErrorMessages } from "../i18n/i18n.js";
import { cvHandover } from "../security/handover.js";
import { AuditWriteError, actorOf, uploadRef, writeAudit } from "../security/audit.js";
import { LimitError } from "../middleware/errorMiddleware.js";
import { queueSalesforce } from '../services/salesforceSync.js';
import { applicationCvKey } from "../dal/jobApplicationDAL.js";


export const uploadFile = async (req: Request, res: Response, next: NextFunction) => {
  const token =req.params.token;
  if (!req.file) {
    return next(new AxiosError(FilesErrorMessages.NO_FILE_UPLOADED, FilesErrorCodes.NO_FILE_UPLOADED));
  }

  const fileType = getFileType(req.file.mimetype)
    try {
      const stored = await uploadFileToS3(req.file.buffer,fileType, req.file.originalname, req.file.mimetype, token);
      // Every upload is on record (ids only: a hash of the stored file, its type and size; never its name).
      void writeAudit(actorOf(req), 'cv.uploaded', null, { upload: uploadRef(stored.fileUrl), type: fileType, size_kb: Math.ceil(stored.size / 1024) });
      res.json({ data: { message: "File uploaded successfully" } });
    } catch (error) {
      if (isAxiosError(error)) {
        return next(error)
      }
      next(new AxiosError(FilesErrorMessages.FILE_UPLOAD_FAILED, FilesErrorCodes.FILE_UPLOAD_FAILED));
    }
};

/** Sends an opened CV as a download (after the hand-over recorded it): never rendered as a page of this site. */
const sendStoredFile = (res: Response, file: Awaited<ReturnType<typeof getStoredFile>>) => {
  res.setHeader('Content-Type', file.contentType);
  if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Cache-Control', 'private, no-store');
  // The file is never rendered as a page of this site, and other sites can't embed it.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  file.stream.on('error', (error) => {
    console.error('Error reading stored file:', (error as Error).message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  file.stream.pipe(res);
};

export const fetchfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {userId} = req.params;
    if (!userId) {
      return next(new AxiosError(FilesErrorMessages.MISSING_USER_ID_IN_PARAMS, FilesErrorCodes.MISSING_USER_ID_IN_PARAMS));
    }
    const cvFileUrl = await fetchCvUrlByUserId(userId);
    // Limit → open from storage → strict record → only then send (see security/handover.ts).
    const file = await cvHandover({
      who: actorOf(req),
      subjectId: String(userId),
      place: String(req.get('referer') ? new URL(req.get('referer')!, 'http://x').pathname : 'GET /api/files/:userId').slice(0, 200),
      open: () => getStoredFile(cvFileUrl),
      abort: (f) => f.stream.destroy(),
      details: (f) => ({ type: f.contentType }),
    });

    sendStoredFile(res, file);
  } catch (error: any) {
    if (error instanceof AuditWriteError || error instanceof LimitError) return next(error);
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(FilesErrorMessages.FILE_FETCH_FAILED, FilesErrorCodes.FILE_FETCH_FAILED));
  }
};

// DELETE /files
//  - content manager with a userId: UNLINKS that candidate's CV from the profile. The file is kept: applications
//    point to it and nothing a candidate sent is ever deleted (owner's rule). Logged as candidate.cv_unlinked.
//  - anyone else: may only cancel an upload that is still pending, i.e. one they
//    just made in the sign-up/apply form and that is not attached to anybody or any application.
export const deleteFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) } as Record<string, any>;
    const cvFileUrl = typeof src.cvFileUrl === 'string' ? src.cvFileUrl : '';
    const userId = typeof src.userId === 'string' ? src.userId : '';
    if (!cvFileUrl) {
      return next(new AxiosError(FilesErrorMessages.MISSING_CV_PATH, FilesErrorCodes.MISSING_CV_PATH));
    }

    if (canManageContent(req.authJwtPayload?.userRole) && userId) {
      // The file must be this candidate's own CV (not some other stored file, not a staff account's).
      const owner = await userDAL.findUserById(userId);
      if (!owner || !isCandidate(owner) || owner.cvFileUrl !== cvFileUrl) {
        return next(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN));
      }
      const updateUserDto: UpdateUserDto = { cvFileUrl: '' };
      await userDAL.updateUserById(userId, updateUserDto, { candidatesOnly: true });
      void queueSalesforce('candidate', userId);
      void writeAudit(actorOf(req), 'candidate.cv_unlinked', userId, { ids: [userId] });
      return res.status(200).json({ data: { message: 'CV removed from the profile (the file is kept)' } });
    }
    const deleted = await deletePendingUpload(cvFileUrl);
    if (!deleted) {
      return next(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN));
    }
    return res.status(200).json({ data: { message: 'File deleted' } });
  } catch (error: any) {
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(FilesErrorMessages.FILE_DELETE_FAILED, FilesErrorCodes.FILE_DELETE_FAILED));
  }
};


export default { uploadFile };

// GET /admin/users/:userId/applications/:jobId/cv — staff open the CV that was sent with ONE application (a CV for
// that job only is not on the profile, so GET /files/:userId can't reach it). Through cvHandover like every CV:
// daily limit, strict log entry (candidate.cv_opened, via this route) before the file leaves, alerts.
export const fetchApplicationCv = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId ?? '');
    const jobId = String(req.params.jobId ?? '');
    const key = await applicationCvKey(userId, jobId);
    if (!key) return res.status(404).json({ message: FilesErrorMessages.APPLICATION_CV_NOT_FOUND, code: FilesErrorCodes.APPLICATION_CV_NOT_FOUND });
    const file = await cvHandover({
      who: actorOf(req),
      subjectId: userId,
      place: 'GET /api/admin/users/:userId/applications/:jobId/cv',
      open: () => getStoredFile(key),
      abort: (f) => f.stream.destroy(),
      details: (f) => ({ type: f.contentType, job: jobId }),
    });
    sendStoredFile(res, file);
  } catch (error: any) {
    if (error instanceof AuditWriteError || error instanceof LimitError) return next(error);
    if (isAxiosError(error)) return next(error);
    next(new AxiosError(FilesErrorMessages.FILE_FETCH_FAILED, FilesErrorCodes.FILE_FETCH_FAILED));
  }
};
