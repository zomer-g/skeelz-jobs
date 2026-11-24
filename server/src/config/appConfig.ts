import dotenv from 'dotenv';
import { Config } from '../models/interfaces/config.js';
import { readSalesforceSettings } from './salesforceSettings.js';

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
    // Email goes out through Resend only when this is true (and RESEND_API_KEY + EMAIL_FROM are set): services/emailService.ts.
    sendEmailDisabled: process.env.SEND_EMAIL_ENABLED !== 'true',
    clientBaseUrl: process.env.CLIENT_BASE_URL || process.env.BASE_URL || '',
    applicationNotificationEmail: process.env.APPLICATION_NOTIFICATION_EMAIL || '',
    supportEmail: process.env.SUPPORT_EMAIL || '',
    smoove: {
        enableSmoove: process.env.ENABLE_SMOOVE == 'true',
        smooveApiKey : process.env.SMOOVE_API_KEY || '',
        smooveListId : process.env.SMOOVE_LIST_ID || '',
        smooveGuestListId : process.env.SMOOVE_GUEST_LIST_ID || '',
        // SMOOVE_API_URL (a local mock for test/e2e-consent.mjs) is honoured ONLY with DEV_MODE=true.
        smooveApiUrl : (process.env.DEV_MODE === 'true' && process.env.SMOOVE_API_URL) || "https://rest.smoove.io/v1/contacts",
    },
    // Every Salesforce setting is validated in salesforceSettings.ts; `enableSalesforce` is true only when
    // ENABLE_SALESFORCE=true AND all of them are valid (and not in the sandbox).
    salesforce: (() => {
        const s = readSalesforceSettings(process.env);
        return { ...s, enableSalesforce: s.enabled };
    })(),
};

export default appConfig;