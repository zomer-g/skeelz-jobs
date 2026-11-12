import dotenv from 'dotenv';
import { Config } from '../models/interfaces/config.js';

dotenv.config();

const appConfig: Config = {
    port: parseInt(process.env.XHOST_HTTP_PORT || process.env.PORT || '3000', 10),
    // xhostd injects DATABASE_URL (its own Postgres) at runtime.
    dbURL: process.env.DATABASE_URL || process.env.DB_URL || '',
    isDevMode: process.env.DEV_MODE === 'true',
    accessTokenLifeSeconds: Number(process.env.ACCESS_TOKEN_LIFE_SECONDS) || 15 * 60, // 15 minutes as default
    refreshTokenLifeSeconds: Number(process.env.REFRESH_TOKEN_LIFE_SECONDS) || 60 * 24 * 60 * 60, // 60 days as default
    passwordResetTokenLifeSeconds: Number(process.env.RESET_TOKEN_LIFE_SECONDS) || 10 * 60, // 10 minutes as default
    allowedOrigins: process.env.ALLOWED_ORIGINS || '',
    accessTokenSecret: process.env.ACCESS_TOKEN_SECRET || '',
    refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || '',
    passwordResetTokenSecret: process.env.RESET_TOKEN_SECRET || '',
    useOTP: process.env.USE_OTP === 'true',
    sourceEmail: process.env.SOURCE_EMAIL || '',
    emailDisplayName: process.env.EMAIL_DISPLAY_NAME || 'SKEELZ',
    // No email provider is connected (see services/emailService.ts); this flag no longer sends anything.
    sendEmailDisabled: process.env.SEND_EMAIL_ENABLED !== 'true',
    clientBaseUrl: process.env.CLIENT_BASE_URL || process.env.BASE_URL || '',
    applicationNotificationEmail: process.env.APPLICATION_NOTIFICATION_EMAIL || '',
    supportEmail: process.env.SUPPORT_EMAIL || '',
    smoove: {
        enableSmoove: process.env.ENABLE_SMOOVE == 'true',
        smooveApiKey : process.env.SMOOVE_API_KEY || '',
        smooveListId : process.env.SMOOVE_LIST_ID || '',
        smooveGuestListId : process.env.SMOOVE_GUEST_LIST_ID || '',
        smooveApiUrl : "https://rest.smoove.io/v1/contacts",
    },
    salesforce: {
        enableSalesforce: process.env.ENABLE_SALESFORCE == 'true',
        clientId: process.env.SALESFORCE_CLIENT_ID || '',
        clientSecret: process.env.SALESFORCE_CLIENT_SECRET || '',
        loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
        apiVersion: process.env.SALESFORCE_API_VERSION || 'v57.0',
        contactsAccountId: process.env.SALESFORCE_CONTACTS_ACCOUNT_ID || '',
        jobCaseAccountId: process.env.SALESFORCE_CASE_ACCOUNT_ID || '',
        jobCaseRecordTypeId: process.env.SALESFORCE_CASE_RECORD_TYPE_ID || '',
        jobApplicationsCaseAccountId: process.env.SALESFORCE_JOBAPPLICATIONS_ACCOUNT_ID || '',
        jobApplicationsCaseRecordTypeId: process.env.SALESFORCE_JOBAPPLICATIONS_CASE_RECORD_TYPE_ID || '',
    }
};

export default appConfig;