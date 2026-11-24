export enum GlobalErrorCodes {
    GENERAL_ERROR = 'ge1', // General Error
    ILLEGAL_ARGUMENT = 'ge2',
    INVALID_ID_FORMAT = 'ge3',
}

export enum GlobalErrorMessages {
    GENERAL_ERROR = 'An unexpected error occurred',
    ILLEGAL_ARGUMENT = 'Illegal Argument',
    INVALID_ID_FORMAT = 'Invalid ID format',
}

export enum DatabaseErrorMessages {
    GET_JOBS_FAILED = 'Fetch jobs failed',
    GET_JOB_FAILED = 'Fetch job failed',
    CREATE_USER_FAILED = 'Create user failed',
}

export enum DatabaseErrorCodes {
    GET_JOBS_FAILED = 'jb1',
    GET_JOB_FAILED = 'jb2',
    CREATE_USER_FAILED  = 'create user failed',
    CREATE_JOB_FAILED = 'Failed to create new job',

}

export enum JobsErrorMessages {
    FETCH_FAILED = 'Failed to fetch jobs',
    JOB_NOT_FOUND = 'Job not found',
    ALREADY_APPLIED = "User has already applied to this job",
    APPLY_JOB = 'Failed to submit this job application',
    CREATE_JOB_FAILED = 'Failed to create new job',
    UPDATE_JOB_FAILED = 'Failed to update job',
    JOB_ID_GENERATION_FAILED = 'Job ID Generation faild',
    FETCH_JOB_APPLICATIONS_FAILED = 'Failed to fetch job applications',
    APPLY_JOB_AS_A_GUEST_FAILD = 'Failed to submit this job application as a guest',
    QUICK_APPLY_DISABLED = 'Quick apply is not available for this job; please register to apply',
    CV_REQUIRED = 'A CV is required to apply for this job',
    GUEST_ALREADY_APPLIED = 'An application with this email address was already sent for this job',
    SELF_APPLY_ONLY = 'This job is applied for directly with the employer (see the contact details on the job page)',
    INVALID_CV_CHOICE = 'The CV for this application is missing or invalid',
}

export enum JobsErrorCodes {
    FETCH_FAILED = 'jb1',
    JOB_NOT_FOUND = 'jb2',
    ALREADY_APPLIED = "jb3",
    APPLY_JOB = 'jb4',
    CREATE_JOB_FAILED = 'jb5',
    UPDATE_JOB_FAILED = 'jb6',
    JOB_ID_GENERATION_FAILED = 'jb7',
    FETCH_JOB_APPLICATIONS_FAILED = 'jb8',
    APPLY_JOB_AS_A_GUEST_FAILD = 'jb9',
    QUICK_APPLY_DISABLED = 'jb10',
    CV_REQUIRED = 'jb11',
    SELF_APPLY_ONLY = 'jb12',
    INVALID_CV_CHOICE = 'jb12',
    GUEST_ALREADY_APPLIED = 'jb13',
}

export enum LocationsErrorMessages {
    FETCH_FAILED = 'Failed to fetch locations',
    JOB_LOCATION_FETCH_FAILED = 'Failed to fetch job location',
    FETCH_FAILED_LOCATION_AND_DISTRICTS = 'Failed to fetch locations AND Districts',
    LOCATION_NOT_FOUND = 'location not found',
    INVALID_CITY_SYMBOL = 'Invalid city symbol',
}

export enum LocationsErrorCodes {
    FETCH_FAILED = 'lc1',
    JOB_LOCATION_FETCH_FAILED = 'lc2',
    FETCH_FAILED_LOCATION_AND_DISTRICTS = 'lc3',
    LOCATION_NOT_FOUND = 'lc4',
    INVALID_CITY_SYMBOL = 'lc5',

}

export enum SkillsErrorMessages {
    FETCH_FAILED = 'Failed to fetch skills',
}

export enum SkillsErrorCodes {
    FETCH_FAILED = 'sk1',
}

export enum AuthErrorCodes {
    FORBIDDEN = 'au1',
    UNAUTHORIZED = 'au2',
    INVALID_REFRESH_TOKEN = 'au3',
    REFRESH_TOKEN_NOT_FOUND = 'au4',
    INVALID_CREDENTIALS = 'au5',
    WRONG_EMAIL = 'au6',
    WRONG_PASSWORD = 'au7',
    MISSING_PASSWORD = 'au8',
    USER_ALREADY_EXISTS = 'au9',
    STAFF_SSO_ONLY = 'au10',
    SSO_SIGNUP_EXPIRED = 'au11',
    // Sign-in by a code sent by email (controllers/emailSigninController.ts).
    EMAIL_CODE_INVALID = 'au12',
    EMAIL_CODE_LOCKED = 'au13',
    EMAIL_CODE_WAIT = 'au14',
    EMAIL_SIGNUP_EXPIRED = 'au15',
    INVALID_EMAIL = 'au16',
    ACCOUNT_UNAVAILABLE = 'au17',
    EMAIL_CODE_DISABLED = 'au18',
}

export enum AuthErrorMessages {
    FORBIDDEN = 'Forbidden',
    UNAUTHORIZED = 'Unauthorized',
    INVALID_REFRESH_TOKEN = 'Invalid refresh token',
    REFRESH_TOKEN_NOT_FOUND = 'Refresh token not found',
    INVALID_CREDENTIALS = 'Invalid credentials',
    WRONG_EMAIL = 'Wrong Email',
    WRONG_PASSWORD = 'Wrong Password',
    MISSING_PASSWORD = 'Missing Password',
    USER_ALREADY_EXISTS = 'User already exists',
    STAFF_SSO_ONLY = 'Staff accounts sign in with the staff (xhostd SSO) button only',
    SSO_SIGNUP_EXPIRED = 'The Google sign-up has expired: continue with Google again',
    EMAIL_CODE_INVALID = 'The code is wrong or has expired',
    EMAIL_CODE_LOCKED = 'Too many tries with this code: ask for a new one',
    EMAIL_CODE_WAIT = 'Please wait before asking for another code',
    EMAIL_SIGNUP_EXPIRED = 'The sign-up has expired: ask for a new code',
    INVALID_EMAIL = 'Invalid email address',
    ACCOUNT_UNAVAILABLE = 'This account cannot sign in',
    EMAIL_CODE_DISABLED = 'Sign-in by email code is not available yet',
}

export enum EmailErrorCodes {
    EMAIL_FAILED = 'em1',
    NOT_CONFIGURED = 'em2',
    NETWORK = 'em3',
    REFUSED = 'em4',
}

export enum EmailErrorMessages {
    EMAIL_FAILED = 'Failed to send email',
}

export enum ValidationErrorMessages {
    INVALID_JOB_ID = 'The provided job ID is not valid',
    FILE_TYPE_NOT_ALLOWED = 'File type not allowed',
    FILE_TYPE_VALIDATION_FAILED = 'File type validation failed',
    FILE_MAX_SIZE_EXCEEDED = 'File size exceeds the maximum allowed size of 500MB',
    INVALID_CSV_FILE = 'The uploaded CSV file is invalid',
    EXCEL_FILE_CONTAINS_THREATS = 'The uploaded Excel file contains potentially dangerous content',
    INVALID_PDF_FILE = 'The uploaded PDF file is invalid',
    NO_FILE_UPLOADED = 'No file uploaded',
    FILE_NAME_TOO_LONG = "The file name is too long, Maximum 50 characters",
    FILE_NAME_INVALID_CHARACTERS = "The file name contains invalid characters",
}

export enum ValidationErrorCodes {
    INVALID_JOB_ID = 'vl1',
    FILE_TYPE_NOT_ALLOWED = 'vl2',
    FILE_TYPE_VALIDATION_FAILED = 'vl3',
    FILE_MAX_SIZE_EXCEEDED = 'vl4',
    INVALID_CSV_FILE = 'vl6',
    EXCEL_FILE_CONTAINS_THREATS = 'vl7',
    INVALID_PDF_FILE = 'v8',
    NO_FILE_UPLOADED = 'v9',
    FILE_NAME_TOO_LONG = "v10",
    FILE_NAME_INVALID_CHARACTERS = "v11",
}

export enum UserErrorMessages {
    USER_JOB_APPLICATION_UPDATE_FAILED = "Failed to update job applications for the user",
    EMAIL_EXISTS = 'EMAIL_EXISTS',
    PHONE_NUMBER_EXISTS = 'PHONE_NUMBER_EXISTS',
    FETCH_FAILED = 'Failed to fetch users',
    UPDATE_USER_FAILED = 'Update user failed',
    CREATE_USER_FAILED = 'Create user failed',
    INVALID_CITYSYMBOL = 'invalid user citySymbol',
    USER_NOT_FOUND = 'User not found',
    FIND_USER_BY_ID_FAILED = 'Find user by ID failed',
    FIND_USER_BY_EMAIL_FAILED = 'Find user by email failed',
    UPDATE_USER_BY_ID_FAILED = 'Update user by ID failed',
    UPDATE_USER_PASSWORD_FAILED = 'Update user password failed',
    CREATE_USER_AT_SMOOVE_FAILED = 'Create user at Smoove failed',
    CREATE_GUEST_AT_SMOOVE_FAILED = 'Create guest at Smoove failed',
}

export enum UserErrorCodes {
    USER_JOB_APPLICATION_UPDATE_FAILED = "us1",
    EMAIL_EXISTS = 'us2',
    PHONE_NUMBER_EXISTS = 'us3',
    FETCH_FAILED = 'us4',
    UPDATE_USER_FAILED = 'us5',
    CREATE_USER_FAILED = 'us6',
    INVALID_CITYSYMBOL = 'us7',
    USER_NOT_FOUND = 'us8',
    FIND_USER_BY_ID_FAILED = 'us9',
    FIND_USER_BY_EMAIL_FAILED = 'us10',
    UPDATE_USER_BY_ID_FAILED = 'us11',
    UPDATE_USER_PASSWORD_FAILED = 'us12',
    CREATE_USER_AT_SMOOVE_FAILED = 'us13',
    CREATE_GUEST_AT_SMOOVE_FAILED = 'us14',
}

export enum FilesErrorCodes {
    FAILED_TO_UPLOAD_FILE_S3 = 'fe1',
    FAILED_TO_FETCH_TAGS_S3 = 'fe2',
    FAILED_TO_MOVE_FILE_S3 = 'fe3',
    FILE_NOT_FOUND_S3 = 'fe4',
    FAILED_TO_FETCH_FILE_S3 = 'fe5',
    MISSING_ENV_S3_BUCKET_NAME = 'fe6',
    INVALID_S3_KEY_FORMAT = 'fe7',
    FAILED_TO_DELETE_FILE_OR_FOLDER_S3 = 'fe8',
    SCAN_TIMEOUT = 'fe9',
    FILE_DELETE_FAILED = 'fe10',
    FILE_FETCH_FAILED = 'fe11',
    FILE_UPLOAD_FAILED = 'fe12',
    GET_FILE_SIZE_FAILED = 'fe13',
    FILE_NOT_UPLOADED_OR_CLEAN = 'fe14',
    PDF_FILE_SANITIZATION_FAILED = 'fe15',
    USER_NOT_FOUND = 'fe16',
    CV_NOT_FOUND = 'fe17',
    NO_FILE_UPLOADED = 'fe18',
    MISSING_USER_ID_IN_PARAMS = 'fe219',
    MISSING_CV_PATH = 'fe20',
    FileNameEncodingFailed = "fe21",
    APPLICATION_CV_NOT_FOUND = 'fe22',

    
}

export enum FilesErrorMessages {
    FAILED_TO_UPLOAD_FILE_S3 = 'Failed to upload the file',
    FAILED_TO_FETCH_TAGS_S3 = 'Error retrieving tags from the file storage',
    FAILED_TO_MOVE_FILE_S3 = 'Failed to move the file in the file storage',
    FILE_NOT_FOUND_S3 = 'File not found in the file storage',
    FAILED_TO_FETCH_FILE_S3 = 'Failed to retrieve file from the file storage',
    MISSING_ENV_S3_BUCKET_NAME = 'Missing environment variable S3_BUCKET_NAME',
    INVALID_S3_KEY_FORMAT = 'Invalid S3 key format',
    FAILED_TO_DELETE_FILE_OR_FOLDER_S3 = 'Failed to delete file and/or folder from the file storage',
    SCAN_TIMEOUT = 'File scan timed out. Please retry.',
    FILE_DELETE_FAILED = 'Failed to delete file',
    FILE_FETCH_FAILED = 'Failed to fetch file',
    FILE_UPLOAD_FAILED = 'Failed to upload file',
    GET_FILE_SIZE_FAILED = 'Failed to retrieve the file size from the bucket',
    FILE_NOT_UPLOADED_OR_CLEAN = 'Some files are not fully uploaded or clean',
    PDF_FILE_SANITIZATION_FAILED = 'Failed to scan or sanitize the PDF. Please upload a valid file.',
    USER_NOT_FOUND = 'Failed to find user.',
    CV_NOT_FOUND = 'This candidate has no CV on the profile',
    APPLICATION_CV_NOT_FOUND = 'No CV was sent with this application',
    NO_FILE_UPLOADED = 'No file uploaded',
    MISSING_USER_ID_IN_PARAMS = 'Missing userID in request params',
    MISSING_CV_PATH = 'Missing CV path in the request body',
    FileNameEncodingFailed = "Failed to fix file name encoding",   
}

export enum SalesforceErrorCodes {
    FAILED_TO_CREATE_CONTACT = 'sf1',
    FAILED_TO_UPDATE_CONTACT = 'sf2',
    FAILED_TO_CREATE_CASE = 'sf3',
    FAILED_TO_UPDATE_CASE = 'sf4',
    FAILED_TO_GET_CONTENT_VERSION_ID = 'sf5',
    CONTENT_DOCUMENT_ID_NOT_FOUND = 'sf6',
    CONTACT_NOT_FOUND = 'sf7',
    FAILED_TO_UPLOAD_CV = 'sf8',
  }

  export enum SalesforceErrorMessages {
    FAILED_TO_CREATE_CONTACT = 'Failed to create contact',
    FAILED_TO_UPDATE_CONTACT = 'Failed to update contact',
    FAILED_TO_CREATE_CASE = 'Failed to create Case.',
    FAILED_TO_UPDATE_CASE = 'Failed to update Case',
    FAILED_TO_GET_CONTENT_VERSION_ID = 'failed to get contentVersion ID.',
    CONTENT_DOCUMENT_ID_NOT_FOUND = 'ContentDocumentId not found for ContentVersionId',
    CONTACT_NOT_FOUND = 'Contact not found',
    FAILED_TO_UPLOAD_CV = 'Failed to upload CV',
  };
