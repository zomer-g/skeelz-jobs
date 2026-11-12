import { AxiosError } from 'axios';
import { validatePDF, sanitizePDF } from '../utils/pdfValidationUtils.js';
import { getUserById } from './userService.js';
import {FilesErrorCodes, FilesErrorMessages } from '../i18n/i18n.js';

export const validateAndSanitizeFile = async (fileBuffer: Buffer, fileType: string): Promise<{ fileBuffer: Buffer, sanitized: boolean }> => {
  try{
    let sanitized = false;
  
    if (fileType === 'pdf') {
      const needsSanitization = await validatePDF(fileBuffer);
      if (needsSanitization) {
        fileBuffer = await sanitizePDF(fileBuffer);
      }
        sanitized = true;
    }else if (fileType === 'docx' ){
      // A .docx renamed from a macro-enabled document still carries its VBA
      // project; file names in a zip are stored uncompressed, so this is reliable.
      if (fileBuffer.includes('vbaProject.bin') || fileBuffer.includes('activeX')) {
        return { fileBuffer, sanitized: false };
      }
      sanitized = true;
    }
    return { fileBuffer, sanitized };

  } catch(error){
    throw new AxiosError(FilesErrorMessages.PDF_FILE_SANITIZATION_FAILED, FilesErrorCodes.PDF_FILE_SANITIZATION_FAILED);
  }
};

export const fetchCvUrlByUserId = async (userId: string): Promise<string> => {
  try {
    const user = await getUserById(userId);
    const cvUrl = user?.cvFileUrl;
    if (cvUrl) {
      return cvUrl;
    }
    throw new AxiosError(FilesErrorMessages.CV_NOT_FOUND, FilesErrorCodes.CV_NOT_FOUND);
    
  } catch (error) {
      throw new AxiosError(FilesErrorMessages.USER_NOT_FOUND, FilesErrorCodes.USER_NOT_FOUND);
  }
};