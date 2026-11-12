import axios, { AxiosError } from "axios";
import { GlobalErrorCodes, GlobalErrorMessages } from "../i18n/i18n.js";
import IUser from "../models/schemas/user.js";
import moment from "moment-timezone";
import { Readable } from 'stream';



export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return undefined;
}

export const isEnglishString = (text: string): boolean => {
    return /^[A-Za-z0-9 ._\-()]+$/.test(text);
  }

export const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
    const chunks: Uint8Array[] = [];
  
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  };
  
export const formatToIsraelTime = (date: Date): string => {
    return new Intl.DateTimeFormat('he-IL', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Jerusalem'
    }).format(date);
};

export const convertToIsraelTimeAndStoreAsUTC = (date: string): string => {
    // Step 1: Parse the input date as UTC
    const dateInUTC = moment.utc(date);

    // Step 2: Get the offset of Israel Time from UTC at that date
    const israelOffset = moment.tz("Asia/Jerusalem").utcOffset();

    // Step 3: Adjust the date to reflect Israel local time in UTC
    const dateInIsraelUTC = dateInUTC.add(israelOffset, 'minutes').toISOString();
    return dateInIsraelUTC;
};


export const getFileExtension = (fileName: string): string => {
    return fileName.split('.').pop()?.toLowerCase() || '';
};

// Utility function to exclude sensitive fields like password
export const excludePassword = (user: IUser) => {
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
};

export const logAxiosError = (error: unknown, customMessage: string): void => {
    if (axios.isAxiosError(error)) {
        if (error.response) {
            // API responded with an error
            console.error(`${customMessage} - API Error:`, error.response.data);
            console.error('Status Code:', error.response.status);
        } else if (error.request) {
            // Request made but no response received
            console.error(`${customMessage} - No response received:`, error.code ?? error.message);
        } else {
            // Something happened in setting up the request
            console.error(`${customMessage} - Request Error:`, error.message);
        }
    } else if (error instanceof Error) {
        // Non-Axios error
        console.error(`${customMessage} - Error:`, error.message);
    } else {
        // Completely unknown error
        console.error(`${customMessage} - Unknown Error:`, error);
    }
};

export { newObjectId as generateRandomId } from './ids.js';