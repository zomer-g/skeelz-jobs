import { UserRole, isCandidate } from '../models/enums.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import * as userDAL from '../dal/userDAL.js';
import { UpdateUserDto } from '../dto/updateUserDto.js';
import IUser from '../models/schemas/user.js';
import { AxiosError, isAxiosError } from 'axios';
import { UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { mailWelcome } from '../mail/triggers.js';
import { usersFilter } from '../models/interfaces/general.interface.js';
import { queueSalesforce } from './salesforceSync.js';
import * as smooveService from './smooveService.js'
import { convertToIsraelTimeAndStoreAsUTC} from '../utils/utils.js';
import { CvAttachAudit, claimCvUpload } from './s3Service.js';
import * as locationService from '../services/locationService.js';
import { mayPushToList } from './marketingList.js';
import { linkRemovalToNewCandidate } from '../dal/marketingDAL.js';



export const fetchAllUsers = async (usersFilterParams?: usersFilter): Promise<{
  users: IUser[];
  total: number
}> => {
  return await userDAL.findAll(usersFilterParams || {});
};

const handleEmailConflicts = (existingUser: IUser | null, email?: string): void => {
  if (existingUser) {
    if  (existingUser.email.toLowerCase() === email?.toLowerCase()) {
      throw new AxiosError(UserErrorMessages.EMAIL_EXISTS, UserErrorCodes.EMAIL_EXISTS);
    }
  }
}

const handlePhoneNumberConflicts = (existingUser: IUser | null, phoneNumber?: string): void => {
  if (existingUser) {
    if (existingUser.phoneNumber === phoneNumber) {
      throw new AxiosError(UserErrorMessages.PHONE_NUMBER_EXISTS, UserErrorCodes.PHONE_NUMBER_EXISTS);
    }
  }
}

const checkUserConflictsForCreation = async (email: string ,phoneNumber: string ,citySymbol: number): Promise<void> => {
  if (citySymbol < 0) {
    throw new AxiosError(UserErrorMessages.INVALID_CITYSYMBOL, UserErrorCodes.INVALID_CITYSYMBOL);
  }
  const existingUser = await userDAL.findUserByEmail(email);
  handleEmailConflicts(existingUser, email);
  if(!existingUser && phoneNumber){
    handlePhoneNumberConflicts(await userDAL.findUserByPhoneNumber(phoneNumber), phoneNumber);
  }
};

/**
 * A new candidate. Candidates have no password (since 11.2026): they sign in with Google (xhostd SSO), Microsoft, or
 * with a code sent by email. The email always comes from a verified source the caller holds (the SSO identity, or the
 * address a code was sent to), never from the request body.
 * `sso`: after "Continue with Google / Microsoft": the account is linked to the SSO subject (`provider` 'microsoft' →
 * users.ms_sub, else users.xhostd_sub).
 */
export const createUser = async (createUserDto: CreateUserDto, opts: { sso?: { sub: string; provider?: 'xhostd' | 'microsoft' }; consent: { marketing: boolean } }): Promise<{
  _id: any; user: IUser
}> => {
  createUserDto.email = String(createUserDto.email || '').toLowerCase().trim();
  const isText = (v: unknown, max = 100) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(createUserDto.email) || !isText(createUserDto.firstName) || !isText(createUserDto.lastName)
      // Phone and town may be optional (the sign-up fields setting, checked by the controller with checkProfile).
      || (createUserDto.phoneNumber && !isText(createUserDto.phoneNumber, 30)) || !Number.isFinite(Number(createUserDto.citySymbol ?? 0))) {
    throw new AxiosError(UserErrorMessages.CREATE_USER_FAILED, UserErrorCodes.CREATE_USER_FAILED);
  }
  createUserDto.citySymbol = Number(createUserDto.citySymbol ?? 0);
  const { email,phoneNumber,citySymbol } = createUserDto;
  await checkUserConflictsForCreation(email,phoneNumber,citySymbol);
  const requestedCv = createUserDto.cvFileUrl;
  createUserDto.cvFileUrl = '';
  if (createUserDto.dateOfBirth) createUserDto.dateOfBirth = convertToIsraelTimeAndStoreAsUTC(createUserDto.dateOfBirth);
  let createdUser: IUser = await userDAL.createUser(createUserDto, {
    ssoSub: opts.sso && opts.sso.provider !== 'microsoft' ? opts.sso.sub : undefined,
    msSub: opts.sso?.provider === 'microsoft' ? opts.sso.sub : undefined,
    consent: opts.consent,
  });
  // An earlier removal of this address: cleared by their own "yes" here, else shown on the new account.
  await linkRemovalToNewCandidate(String(createdUser.id), createdUser.email, opts.consent.marketing === true);
  // The CV must be an upload that nobody owns yet; it becomes this user's.
  const cvKey = await claimCvUpload(requestedCv, createdUser.id, { via: 'signup' });
  if (cvKey) {
    createdUser = (await userDAL.updateUserById(createdUser.id, { cvFileUrl: cvKey })) ?? createdUser;
  }
  await mailWelcome(createdUser);
  // Salesforce (when on): queued, sent in the background with retries (services/salesforceSync.ts).
  await queueSalesforce('candidate', String(createdUser.id));
  // The mailing list gets only people who ticked the marketing box (and only when SMOOV is on).
  // (after linkRemovalToNewCandidate: their own verified "yes" cleared an earlier removal; anything else keeps it).
  if (await mayPushToList(createdUser.email, opts.consent.marketing)) {
    const location = createdUser.citySymbol > 0 ? await locationService.getLocationByCitySymbol(createdUser.citySymbol) : null;
    await smooveService.createSmooveContact(createdUser, location?.city ?? '');
  }
  return {
    _id: createdUser.id,
    user: createdUser,
  };
};



export const updateUserById = async (userId: string, updateUserDto: UpdateUserDto, opts: { candidatesOnly?: boolean; cvAudit?: CvAttachAudit } = {}) => {
  try{
    if (opts.candidatesOnly) {
      const target = await userDAL.findUserById(userId);
      if (!target || !isCandidate(target)) return null;
    }
    if (updateUserDto.cvFileUrl) {
      const cvKey = await claimCvUpload(updateUserDto.cvFileUrl, userId, opts.cvAudit ?? { via: 'profile' });
      if (cvKey) {
        updateUserDto.cvFileUrl = cvKey;
      } else {
        delete updateUserDto.cvFileUrl;
      }
    }
    const updatedUser = await userDAL.updateUserById(userId, updateUserDto, opts);
    // Candidates only (the queue checks the role); staff and employers are never sent as candidates.
    if (updatedUser) await queueSalesforce('candidate', userId);
    return updatedUser;
  } catch(error){
    if(isAxiosError(error)){
      throw (error)
    }
    throw new AxiosError(UserErrorMessages.UPDATE_USER_BY_ID_FAILED, UserErrorCodes.UPDATE_USER_BY_ID_FAILED);
  }
}

/**
 * Makes an already-claimed upload (`key`, owned by this user) their profile CV.
 * The previous profile CV is kept: past applications may still point to it.
 * Salesforce gets it through the queue (never fails this call).
 */
export const setProfileCv = async (userId: string, key: string): Promise<void> => {
  const updatedUser = await userDAL.updateUserById(userId, { cvFileUrl: key });
  if (!updatedUser) {
    throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
  }
  await queueSalesforce('candidate', userId);
};

export const getUserByEmail =(email: string): Promise<IUser | null> => {
  try{
    return userDAL.findUserByEmail(email);
  } catch(error){
    throw new AxiosError(UserErrorMessages.FIND_USER_BY_EMAIL_FAILED, UserErrorCodes.FIND_USER_BY_EMAIL_FAILED);
  }
}

export const getUserById = (userID: string): Promise<IUser | null> => {
  try{
    return userDAL.findUserById(userID);
  } catch(error){
    throw new AxiosError(UserErrorMessages.FIND_USER_BY_ID_FAILED, UserErrorCodes.FIND_USER_BY_ID_FAILED);
  }
}


/** Does another account already use this phone number? (a candidate changing their own phone) */
export const phoneTakenByOther = async (phoneNumber: string, userId: string): Promise<boolean> => {
  const other = await userDAL.findUserByPhoneNumber(phoneNumber);
  return !!other && String(other.id ?? other._id) !== String(userId);
};
