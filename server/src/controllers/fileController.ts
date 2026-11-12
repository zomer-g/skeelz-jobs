import { NextFunction, Request, Response } from "express";
import { UpdateUserDto } from "../dto/updateUserDto.js";
import { deleteFileAndFolderInS3, deletePendingUpload, getStoredFile, uploadFileToS3 } from "../services/s3Service.js";
import * as userDAL from "../dal/userDAL.js";
import { UserRole } from "../models/enums.js";
import { AuthErrorCodes, AuthErrorMessages } from "../i18n/i18n.js";
import { fetchCvUrlByUserId } from "../services/fileProcessingService.js";
import { getFileType } from "../utils/pdfValidationUtils.js";
import { AxiosError, isAxiosError } from "axios";
import { FilesErrorCodes, FilesErrorMessages } from "../i18n/i18n.js";
import { cvHandover } from "../security/handover.js";
import { AuditWriteError, actorOf, writeAudit } from "../security/audit.js";
import { LimitError } from "../middleware/errorMiddleware.js";


export const uploadFile = async (req: Request, res: Response, next: NextFunction) => {
  const token =req.params.token;
  if (!req.file) {
    return next(new AxiosError(FilesErrorMessages.NO_FILE_UPLOADED, FilesErrorCodes.NO_FILE_UPLOADED));
  }

  const fileType = getFileType(req.file.mimetype)
    try {
      await uploadFileToS3(req.file.buffer,fileType, req.file.originalname, req.file.mimetype, token);
      res.json({ data: { message: "File uploaded successfully" } });
    } catch (error) {
      if (isAxiosError(error)) {
        return next(error)
      }
      next(new AxiosError(FilesErrorMessages.FILE_UPLOAD_FAILED, FilesErrorCodes.FILE_UPLOAD_FAILED));
    }
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
  } catch (error: any) {
    if (error instanceof AuditWriteError || error instanceof LimitError) return next(error);
    if (isAxiosError(error)) {
      return next(error)
    }
    next(new AxiosError(FilesErrorMessages.FILE_FETCH_FAILED, FilesErrorCodes.FILE_FETCH_FAILED));
  }
};

// DELETE /files
//  - content manager with a userId: removes that candidate's stored CV and clears it (UsersTable).
//  - anyone else: may only cancel an upload that is still pending, i.e. one they
//    just made in the sign-up/apply form and that is not attached to anybody.
//    (The old route let anyone delete any file and blank any user's CV.)
export const deleteFile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) } as Record<string, any>;
    const cvFileUrl = typeof src.cvFileUrl === 'string' ? src.cvFileUrl : '';
    const userId = typeof src.userId === 'string' ? src.userId : '';
    if (!cvFileUrl) {
      return next(new AxiosError(FilesErrorMessages.MISSING_CV_PATH, FilesErrorCodes.MISSING_CV_PATH));
    }

    if (req.authJwtPayload?.userRole === UserRole.CONTENT_MANAGER && userId) {
      // The file must be this candidate's own CV (not some other stored file, not a staff account's).
      const owner = await userDAL.findUserById(userId);
      if (!owner || owner.role !== UserRole.USER || owner.cvFileUrl !== cvFileUrl) {
        return next(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN));
      }
      await deleteFileAndFolderInS3(cvFileUrl);
      const updateUserDto: UpdateUserDto = { cvFileUrl: '' };
      await userDAL.updateUserById(userId, updateUserDto, { candidatesOnly: true });
      void writeAudit(actorOf(req), 'candidate.cv_deleted', userId, { ids: [userId] });
    } else {
      const deleted = await deletePendingUpload(cvFileUrl);
      if (!deleted) {
        return next(new AxiosError(AuthErrorMessages.FORBIDDEN, AuthErrorCodes.FORBIDDEN));
      }
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
