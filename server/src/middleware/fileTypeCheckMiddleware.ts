import { Request, Response, NextFunction } from 'express';
import { fileTypeFromBuffer } from 'file-type';
import { ValidationErrorCodes, ValidationErrorMessages } from '../i18n/i18n.js';
import { AxiosError, isAxiosError } from 'axios';
import { getFileExtension } from '../utils/utils.js';

const allowedTypes = ['docx', 'pdf'];
const allowedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/pdf',
];

// Check if extensions are equivalent
const isEquivalentExtension = (fileTypeExt: string, fileNameExt: string) => {
    return (
        fileTypeExt === fileNameExt 
    );
};

// Middleware for file type and content validation
export const fileTypeCheck = (params: { isMultipartUpload: boolean }) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!req.file) {
                return next(new AxiosError(ValidationErrorMessages.NO_FILE_UPLOADED, ValidationErrorCodes.NO_FILE_UPLOADED));
            }
            if (req.file.originalname) {
                const maxLength = 50;
                const allowedPattern = /^[\u0590-\u05FFa-zA-Z0-9 _.-]+$/;

                if (req.file.originalname.length > maxLength) {
                    return next(new AxiosError(ValidationErrorMessages.FILE_NAME_TOO_LONG, ValidationErrorCodes.FILE_NAME_TOO_LONG));
                }

                if (!allowedPattern.test(req.file.originalname)) {
                    return next(new AxiosError(ValidationErrorMessages.FILE_NAME_INVALID_CHARACTERS, ValidationErrorCodes.FILE_NAME_INVALID_CHARACTERS));
                }
            }

            // Handle multipart uploads and skip validation for non-first parts
            if (params.isMultipartUpload) {
                const partNumber = req.body.partNumber;
                if (partNumber && partNumber !== '1') {
                    return next();
                }
            }

            const buffer = req.file.buffer;
            if (!buffer || buffer.length === 0) {
                return res.status(400).json({ message: 'Uploaded file is empty' });
            }
            const fileType = await fileTypeFromBuffer(new Uint8Array(buffer));
            const fileNameExtension = getFileExtension(req.file.originalname).replace('.', '');

            // Check for file type and mime type validity
            if (
                fileType &&
                allowedTypes.includes(fileType.ext) &&           // Check actual file type (extension)
                allowedMimeTypes.includes(fileType.mime) &&     // Check MIME type
                allowedTypes.includes(fileNameExtension) &&     // Check file name extension is allowed
                isEquivalentExtension(fileType.ext, fileNameExtension) // Ensure extensions are equivalent              // Ensure detected type matches file name extension
            ) {
                if (fileType.ext === 'xlsx') {
                    // Validate the file extension for Excel files to ensure that at the end of the upload, 
                    // we can correctly determine if the file should be sanitized based on its extension
                    if (!validateExcelExtension(fileNameExtension)) {
                        return res.status(400).json({ message: 'Invalid file extension for Excel file' });
                    }
                    return next(); // Excel file content validation happens at the end of the upload
                }
                next();
                // CSV files do not have a specific file signature in their content, 
                // so they are validated explicitly by their file extension.
            } else {
                // If file type and extension are invalid
                console.log(`File type not allowed. Detected file extension: ${fileNameExtension} | fileType extension: ${fileType?.ext} | fileType MIME: ${fileType?.mime}`);
                return next(new AxiosError(ValidationErrorMessages.FILE_TYPE_NOT_ALLOWED, ValidationErrorCodes.FILE_TYPE_NOT_ALLOWED));
            }

        } catch (error) {
           console.log('Error determining file type: ' + error);
            const fileID = req.body.fileID;
            if (isAxiosError(error)) {
                return next(error);
            } else {
                return next(new AxiosError(ValidationErrorMessages.FILE_TYPE_VALIDATION_FAILED, ValidationErrorCodes.FILE_TYPE_VALIDATION_FAILED));
            }
        }
    };
};

const validateExcelExtension = (extension: string): boolean => {
    const allowedExcelExtensions = ['xls', 'xlsx']; // Allowed Excel extensions
    return allowedExcelExtensions.includes(extension);
};
