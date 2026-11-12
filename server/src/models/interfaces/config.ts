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
    salesforce: {
        enableSalesforce: boolean,
        clientId: string,
        clientSecret: string,
        loginUrl: string,
        apiVersion: string,
        contactsAccountId: string;
        jobCaseAccountId: string,
        jobCaseRecordTypeId: string,
        jobApplicationsCaseAccountId: string,
        jobApplicationsCaseRecordTypeId: string,
    }
}