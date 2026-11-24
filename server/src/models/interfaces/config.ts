import type { SalesforceSettings } from '../../config/salesforceSettings.js';
export interface Config {
    port: number;
    dbURL: string;
    isDevMode: boolean;
    accessTokenLifeSeconds: number;
    refreshTokenLifeSeconds: number;
    passwordResetTokenLifeSeconds: number;
    allowedOrigins: string;
    accessTokenSecret: string;
    refreshTokenSecret: string;
    passwordResetTokenSecret: string;
    useOTP: boolean;
    sourceEmail: string,
    emailDisplayName: string;
    sendEmailDisabled: boolean,
    clientBaseUrl: string,
    applicationNotificationEmail: string,
    supportEmail: string;
    smoove: {
        enableSmoove: boolean,
        smooveApiKey : string,
        smooveListId : string,
        smooveGuestListId : string,
        smooveApiUrl : string,
    },
    salesforce: SalesforceSettings & { enableSalesforce: boolean }
}