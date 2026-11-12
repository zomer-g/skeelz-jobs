import { i18n } from '../../i18n/I18n';

const ERROR_GENERAL = 'ge';
const ERROR_JB = 'jb';
const ERROR_AU = 'au';
const ERROR_EM = 'em';
const ERROR_US = 'us';
const ERROR_SK = 'sk';
const ERROR_LC = 'lc';
const ERROR_FE = 'fe';
const ERROR_VL = 'vl';
const ERROR_SF = 'sf';


export const ErrorManager = (location: string, codeNumber: number): string => {
    const translations = i18n.getTranslations();
    /**
     * Note: please keep this error map maintained when adding new errors.
     *
     * Error chars map:
     * gn - general errors.
     *
     */

    if (location === ERROR_GENERAL) {
        switch (codeNumber) {
            case 1:
                return translations.GlobalErrors.GENERAL_ERROR;
        }
    } else if (location === ERROR_JB) {
        switch (codeNumber) {
            case 1:
                return translations.JobsErrorMessages.FETCH_FAILED;
            case 2:
                return translations.JobsErrorMessages.JOB_NOT_FOUND;
            case 3:
                return translations.JobsErrorMessages.ALREADY_APPLIED;
            case 4:
                return translations.JobsErrorMessages.APPLY_JOB;
            case 5:
                return translations.JobsErrorMessages.CREATE_JOB_FAILED;
            case 6:
                return translations.JobsErrorMessages.UPDATE_JOB_FAILED;
            case 7:
                return translations.JobsErrorMessages.JOB_ID_GENERATION_FAILED;
            case 8:
                return translations.JobsErrorMessages.FETCH_JOB_APPLICATIONS_FAILED;
            case 9:
                return translations.JobsErrorMessages.APPLY_JOB_AS_A_GUEST_FAILD;
            case 10:
                return translations.JobsErrorMessages.QUICK_APPLY_DISABLED;
            case 11:
                return translations.JobsErrorMessages.CV_REQUIRED;
        }

    }
    else if (location === ERROR_EM) {
        switch (codeNumber) {
            case 1:
                return translations.DatabaseErrorMessages.EMAIL_EXISTS;
        }

    }
    else if (location === ERROR_AU) {
        switch (codeNumber) {
            case 6:
                return translations.AuthErrorMessages.WRONG_EMAIL;
            case 7:
                return translations.AuthErrorMessages.WRONG_PASSWORD;
            case 8:
                return translations.AuthErrorMessages.MISSING_PASSWORD;    
            case 9:
                return translations.AuthErrorMessages.USER_ALREADY_EXISTS;    
            case 10:
                return translations.AuthErrorMessages.STAFF_SSO_ONLY;
            case 11:
                return translations.AuthErrorMessages.SSO_SIGNUP_EXPIRED;
        }
    }

    else if (location === ERROR_US) {
        switch (codeNumber) {
            case 1:
                return translations.userErrorMessages.USER_JOB_APPLICATION_UPDATE_FAILED;
            case 2:
                return translations.DatabaseErrorMessages.EMAIL_EXISTS;
            case 3:
                return translations.Register.PhoneNumberExists;
            case 4:
                return translations.userErrorMessages.FETCH_FAILED;
            case 5:
                return translations.userErrorMessages.UPDATE_USER_FAILED;
            case 6:
                return translations.userErrorMessages.CREATE_USER_FAILED;
            case 7:
                return translations.userErrorMessages.INVALID_CITYSYMBOL;
            case 8:
                return translations.userErrorMessages.USER_NOT_FOUND;
            case 9:
                return translations.userErrorMessages.FIND_USER_BY_ID_FAILED;
            case 10:
                return translations.userErrorMessages.FIND_USER_BY_EMAIL_FAILED;
            case 11:
                return translations.userErrorMessages.UPDATE_USER_BY_ID_FAILED;
            case 12:
                return translations.userErrorMessages.UPDATE_USER_PASSWORD_FAILED;
            case 13:
                return translations.userErrorMessages.CREATE_USER_AT_SMOOVE_FAILED;
            case 14:
                return translations.userErrorMessages.CREATE_GUEST_AT_SMOOVE_FAILED;
        }
    }

    else if (location === ERROR_SK) {
        switch (codeNumber) {
            case 1:
                return translations.GlobalErrors.GENERAL_ERROR;  
            }

    }

    else if (location === ERROR_LC) {
        switch (codeNumber) {
            case 1:
                return translations.Location.RequestFailed;  

            case 2:
                return translations.Location.JobLocationFetchFailed;  
        
            case 3:
                return translations.Location.FetchFailedLocationAndDistricts;  
            
            case 4:
                return translations.Location.LocationNotFound;  

            case 5:
                return translations.Location.InvalidCitySymbol;      
            }

    }

    else if (location === ERROR_SF) {
        switch (codeNumber) {
            case 1:
                return translations.SalesforceRequest.failedToCreateContact;  

            case 2:
                return translations.SalesforceRequest.failedToUpdateContact;
        
            case 3:
                return translations.SalesforceRequest.failedToCreateCase;

            case 4:
                return translations.SalesforceRequest.failedToUpdateCase;

            case 5:
                return translations.SalesforceRequest.failedToGetContentVersionId;

            case 6:
                return translations.SalesforceRequest.contentDocumentIdNotFound;

            case 7:
                return translations.SalesforceRequest.contactNotFound;
                
            case 8:
                return translations.SalesforceRequest.failedToUploadCv;
        }

    }

    else if (location === ERROR_FE) {
        switch (codeNumber) {
            case 1:
                return translations.FilesRequest.FAILED_TO_UPLOAD_FILE_S3;

            case 2:
                return translations.FilesRequest.FAILED_TO_FETCH_TAGS_S3;

            case 3:
                return translations.FilesRequest.FAILED_TO_MOVE_FILE_S3;

            case 4:
                return translations.FilesRequest.FILE_NOT_FOUND_S3;

            case 5:
                return translations.FilesRequest.FAILED_TO_FETCH_FILE_S3;

            case 6:
                return translations.FilesRequest.MISSING_ENV_S3_BUCKET_NAME;

            case 7:
                return translations.FilesRequest.INVALID_S3_KEY_FORMAT;

            case 8:
                return translations.FilesRequest.FAILED_TO_DELETE_FILE_OR_FOLDER_S3;

            case 9:
                return translations.FilesRequest.SCAN_FAILD;

            case 10:
                return translations.FilesRequest.FILE_DELETE_FAILED;

            case 11:
                return translations.FilesRequest.FILE_FETCH_FAILED;

            case 12:
                return translations.FilesRequest.FILE_UPLOAD_FAILED;

            case 13:
                return translations.FilesRequest.GET_FILE_SIZE_FAILED;

            case 14:
                return translations.FilesRequest.FILE_NOT_UPLOADED_OR_CLEAN;

            case 15:
                return translations.FilesRequest.PDF_FILE_SANITIZATION_FAILED;

            case 16:
                return translations.FilesRequest.USER_NOT_FOUND;

            case 17:
                return translations.FilesRequest.CV_NOT_FOUND;

            case 18:
                return translations.FilesRequest.NO_FILE_UPLOADED;

            case 19:
                return translations.FilesRequest.MISSING_USER_ID_IN_PARAMS;

            case 20:
                return translations.FilesRequest.MISSING_CV_PATH;
        }

    } else if (location === ERROR_VL) {
        switch (codeNumber) {
            case 2:
                return translations.Cv.FileTypeNotAllowed; 
            }

    }
    // Should not reach this stage but here in case an error was not handled with a switch.
    return translations.GlobalErrors.GENERAL_ERROR;
}
