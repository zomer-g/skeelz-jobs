import axios from 'axios';
import appConfig from './appConfig.js';
import { logAxiosError } from '../utils/utils.js';

export interface SalesforceAuth {
    access_token: string;
    instance_url: string;
}

export const getSalesforceConfig = async (): Promise<SalesforceAuth> => {
    const { clientId, clientSecret, loginUrl } = appConfig.salesforce;

    try {
        const response = await axios.post(`${loginUrl}/services/oauth2/token`, null, {
            params: {
                grant_type: 'client_credentials', // Using Client Credentials Grant
                client_id: clientId,
                client_secret: clientSecret,
            },
        });

        console.log('Salesforce Authentication Successful.');
        return response.data as SalesforceAuth;
    } catch (error: unknown) {
        logAxiosError(error, 'Salesforce authentication failed');
        throw new Error('Salesforce authentication failed.');
    }
};
