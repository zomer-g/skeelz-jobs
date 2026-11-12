export enum Routes {
    //users
    USERS = 'users',
    //files
    UPLOAD_CV = 'files',
    FETCH_CV = 'files',
    DELETE_CV = 'files',
    MY_CV = 'users/me/cv',
    ME = 'users/me',
    MY_CV_FILE = 'users/me/cv/file',
    //skills
    SKILLS = 'skills',
    //auth
    LOGIN = 'login',
    LOGOUT = 'logout',
    RESET_PASSWORD = 'password/reset',
    PASSWORD_RESET_REQUEST = 'password/reset/initiate',
    AUTH_PROVIDERS = 'auth/providers',
    AUTH_SESSION = 'auth/session',
    SSO_SIGN_IN = 'auth/xhostd/start',
    SSO_SIGN_UP = 'auth/xhostd/signup',
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
    //locations
    GET_ALL_LOCATIONS = 'locations',
    GET_ALL_LOCATIONS_AND_DISTRICTS = 'locations-and-districts',
    //i18n-values
    GET_I18N_VALUES = 'i18n-values'
}