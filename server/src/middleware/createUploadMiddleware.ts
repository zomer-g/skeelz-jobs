import multer from "multer";
import { Request, Response, NextFunction } from "express";
import { AxiosError } from "axios";
import { FilesErrorCodes, FilesErrorMessages } from "../i18n/i18n.js";

const createUploadMiddleware = (options: { fileSizeLimitInMB: number }) => {
  const storage = multer.memoryStorage(); //Store files in memory

  const fileSizeLimitInBytes = Math.floor(options.fileSizeLimitInMB * 1024 * 1024); //Convert MB to bytes
  const upload = multer({
    storage,
    limits: { fileSize: fileSizeLimitInBytes },
  }).single("file"); //key matches React `formData.append("file", file)`

  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: any) => {

      if (err) {
        console.error("Multer Error:", err);
        return res.status(400).json({ message: "File upload error", error: err.message });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      if (req.file.originalname) {
        try {
          const fixedOriginalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
          req.file.originalname = fixedOriginalName;
        } catch (error) {
          console.error(error);
          return next(new AxiosError(FilesErrorMessages.FileNameEncodingFailed, FilesErrorCodes.FileNameEncodingFailed));
        }
      }
      next();
    });
  };
};

export default createUploadMiddleware;
