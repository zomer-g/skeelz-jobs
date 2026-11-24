import axios, { AxiosError } from "axios";
import appConfig from "../config/appConfig.js"; 
import IUser from "../models/schemas/user.js";
import { UserErrorCodes, UserErrorMessages } from "../i18n/i18n.js";
import { Guest } from "../models/interfaces/general.interface.js";



export const createSmooveContact = async (user: IUser,city: string): Promise<void> => {
    if (!appConfig.smoove.enableSmoove) {
        console.log("Smoove operations are disabled in this environment.");
        return;
    } else if(!appConfig.smoove.smooveApiKey || !appConfig.smoove.smooveListId){
        console.log(" You must define SMOOVE_API_KEY and SMOOVE_LIST_ID in the .env file");
    }

    try {
        const contactData = {
            email: user.email,
            firstName: user.firstName || "",
            addedAt: null,
            lastName: user.lastName || "",
            city: city || "",
            cellPhone: user.phoneNumber || "",
            dateOfBirth: new Date(user.dateOfBirth).toISOString().split("T")[0] || '',
            lists_ToSubscribe: [appConfig.smoove.smooveListId],
            mailPermissions: true,
            smsPermissions: true,
            joinSource : 1,
        };

        

        const response = await axios.post(appConfig.smoove.smooveApiUrl, contactData, {
            headers: {
                Authorization: `Bearer ${appConfig.smoove.smooveApiKey}`,
                "Content-Type": "application/json",
            },
        }
    );

    console.log("SMOOV: contact created");

    } catch (error: unknown) {
        throw new AxiosError(UserErrorMessages.CREATE_USER_AT_SMOOVE_FAILED, UserErrorCodes.CREATE_USER_AT_SMOOVE_FAILED);
    }
};

export const createSmooveGuest = async (guest: Guest): Promise<void> => {
    if (!appConfig.smoove.enableSmoove) {
        console.log("Smoove operations are disabled in this environment.");
        return;
    } else if(!appConfig.smoove.smooveApiKey || !appConfig.smoove.smooveGuestListId){
        console.log(" You must define SMOOVE_API_KEY and SMOOVE_LIST_ID in the .env file");
    }

    try {
        const contactData = {
            email: guest.email,
            firstName: guest.fullName || "",
            addedAt: null,
            lists_ToSubscribe: [appConfig.smoove.smooveGuestListId],
            mailPermissions: true,
            joinSource : 1,
        };

        

        const response = await axios.post(appConfig.smoove.smooveApiUrl, contactData, {
            headers: {
                Authorization: `Bearer ${appConfig.smoove.smooveApiKey}`,
                "Content-Type": "application/json",
            },
        }
    );

    console.log("SMOOV: contact created");

    } catch (error: unknown) {
        throw new AxiosError(UserErrorMessages.CREATE_USER_AT_SMOOVE_FAILED, UserErrorCodes.CREATE_USER_AT_SMOOVE_FAILED);
    }
};

export const ensureSmooveGuest = async (guest: Guest): Promise<any> => {
  const url     = appConfig.smoove.smooveApiUrl;
  const headers = {
    Authorization: `Bearer ${appConfig.smoove.smooveApiKey}`,
    "Content-Type": "application/json",
  };

  //Fetch existing contacts in your guest list
  let contacts: any[] = [];
  try {
    const listRes = await axios.get(url, {
      params: { listId: appConfig.smoove.smooveGuestListId },
      headers,
    });
    contacts = Array.isArray(listRes.data)
      ? listRes.data
      : listRes.data.contacts || [];
  } catch {
  }
  const lower = guest.email.trim().toLowerCase();
  if (contacts.some(c => c.email?.toLowerCase() === lower)) {
    console.log("This user already exists at smoove");
    return;
  }
  try {
    const payload = {
      email:             guest.email,
      firstName:         guest.fullName || "",
      addedAt:           null,
      lists_ToSubscribe: [appConfig.smoove.smooveGuestListId],
      mailPermissions:   true,
      joinSource:        1,
    };
    const res = await axios.post(url, payload, { headers });
    console.log("SMOOV: guest created");
    return res.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 409) {
      console.log("This user already exists at smoove");
      return;
    }
    console.error("Failed to create guest at Smoove:", (err as any)?.response?.status ?? (err as any)?.message);
  }
};
/** Unsubscribes an address from every SMOOV list (a removal: services/marketingList.ts). Only when SMOOV is on; the
 *  address goes only in the request path, never in a log (status codes only). */
export const unsubscribeSmooveContact = async (email: string): Promise<void> => {
    if (!appConfig.smoove.enableSmoove || !appConfig.smoove.smooveApiKey) return;
    const url = `${appConfig.smoove.smooveApiUrl.replace(/\/+$/, '')}/${encodeURIComponent(email.trim().toLowerCase())}/Unsubscribe?by=Email`;
    try {
        await axios.post(url, { reason: 'removal requested' }, {
            headers: { Authorization: `Bearer ${appConfig.smoove.smooveApiKey}`, 'Content-Type': 'application/json' },
        });
        console.log('SMOOV: contact unsubscribed');
    } catch (err: unknown) {
        // 404 = never on the list: nothing to do.
        if (axios.isAxiosError(err) && err.response?.status === 404) return;
        console.error('SMOOV: unsubscribe failed', (err as any)?.response?.status ?? (err as any)?.code ?? 'error');
    }
};
