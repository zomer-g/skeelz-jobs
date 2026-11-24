export enum Routes {
    //users
    USERS = 'users',
    //files
    UPLOAD_CV = 'files',
    FETCH_CV = 'files',
    DELETE_CV = 'files',
    MY_CV = 'users/me/cv',
    ME = 'users/me',
    MY_MARKETING_CONSENT = 'users/me/marketing-consent',
    MY_TERMS = 'users/me/terms',
    MY_CV_FILE = 'users/me/cv/file',
    //skills
    SKILLS = 'skills',
    //auth
    LOGOUT = 'logout',
    EMAIL_CODE_REQUEST = 'auth/email/request',
    EMAIL_CODE_VERIFY = 'auth/email/verify',
    EMAIL_SIGN_UP = 'auth/email/signup',
    AUTH_PROVIDERS = 'auth/providers',
    AUTH_SESSION = 'auth/session',
    SSO_SIGN_IN = 'auth/xhostd/start',
    SSO_SIGN_UP = 'auth/xhostd/signup',
    MS_SIGN_IN = 'auth/microsoft/start',
    //jobs
    JOBS_ROUTES_PREFIX = 'jobs',
    GET_ACTIVE_JOBS = 'jobs/active',
    GET_JOBS_NEAR = 'jobs/near',
    ADMIN_GET_ALL_JOBS = 'admin/jobs/with-comments',
    ADD_JOB = 'jobs',
    EDIT_JOB = 'jobs',
    GET_JOB_APPLICATIONS = 'users/job-applications',
    APPLY_JOB = 'apply',
    GUEST_APPLY_JOB = 'guestApply',
    //settings
    APPLY_POLICY_SETTINGS = 'admin/settings/apply-policy',
    EMPLOYER_POSTING_SETTINGS = 'admin/settings/employer-posting',
    //locations
    GET_ALL_LOCATIONS = 'locations',
    GET_ALL_LOCATIONS_AND_DISTRICTS = 'locations-and-districts',
    //i18n-values
    GET_I18N_VALUES = 'i18n-values'
}