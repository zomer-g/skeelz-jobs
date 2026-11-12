import { UserRole } from '../models/enums.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import * as userDAL from '../dal/userDAL.js';
import { comparePassword, hashPassword } from './hashService.js';
import { UpdateUserDto } from '../dto/updateUserDto.js';
import IUser from '../models/schemas/user.js';
import { AxiosError, isAxiosError } from 'axios';
import { UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import * as emailService from './emailService.js';
import { generateWelcomeEmail } from '../utils/emailTemplates.js';
import { usersFilter } from '../models/interfaces/general.interface.js';
import * as salesforceService from './salesforceService.js';
import * as smooveService from './smooveService.js'
import { convertToIsraelTimeAndStoreAsUTC} from '../utils/utils.js';
import { claimCvUpload } from './s3Service.js';
import * as locationService from '../services/locationService.js';



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
  if(!existingUser){
    handlePhoneNumberConflicts(await userDAL.findUserByPhoneNumber(phoneNumber), phoneNumber);
  }
};

/**
 * `sso`: sign-up after "Continue with Google" (xhostd SSO). The email comes from the verified SSO identity (the
 * caller puts it in the dto, never from the request body), there is no password, and the account is linked to
 * the SSO subject. Otherwise the ordinary password sign-up.
 */
export const createUser = async (createUserDto: CreateUserDto, opts: { sso?: { sub: string } } = {}): Promise<{
  _id: any; user: IUser
}> => {
  createUserDto.email = String(createUserDto.email || '').toLowerCase().trim();
  const isText = (v: unknown, max = 100) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const passwordOk = opts.sso
    ? true
    : typeof createUserDto.password === 'string' && createUserDto.password.length >= 6 && createUserDto.password.length <= 200;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(createUserDto.email) || !isText(createUserDto.firstName) || !isText(createUserDto.lastName)
      || !isText(createUserDto.phoneNumber, 30) || !passwordOk || !Number.isFinite(Number(createUserDto.citySymbol))) {
    throw new AxiosError(UserErrorMessages.CREATE_USER_FAILED, UserErrorCodes.CREATE_USER_FAILED);
  }
  createUserDto.citySymbol = Number(createUserDto.citySymbol);
  const { email,phoneNumber,citySymbol } = createUserDto;
  await checkUserConflictsForCreation(email,phoneNumber,citySymbol);
  createUserDto.password = opts.sso ? '' : await hashPassword(createUserDto.password);
  const requestedCv = createUserDto.cvFileUrl;
  createUserDto.cvFileUrl = '';
  createUserDto.dateOfBirth = convertToIsraelTimeAndStoreAsUTC(createUserDto.dateOfBirth);
  let createdUser: IUser = await userDAL.createUser(createUserDto, { ssoSub: opts.sso?.sub });
  // The CV must be an upload that nobody owns yet; it becomes this user's.
  const cvKey = await claimCvUpload(requestedCv, createdUser.id);
  if (cvKey) {
    createdUser = (await userDAL.updateUserById(createdUser.id, { cvFileUrl: cvKey })) ?? createdUser;
  }
  const { subject, text } = generateWelcomeEmail(createdUser);
  await emailService.sendEmail(createdUser.email, subject, text, true);
  await salesforceService.createContact(createdUser);
  if (createdUser.cvFileUrl) {
    await salesforceService.uploadCVFromS3ToSalesforce(createdUser.cvFileUrl, createdUser.id.toString());
  }
  let location= await locationService.getLocationByCitySymbol(createdUser.citySymbol);
  await smooveService.createSmooveContact(createdUser,location.city);
  return {
    _id: createdUser.id,
    user: createdUser,
  };
};



export const updateUserPassword = async (userID: string, hashedPassword: string): Promise<void> => {
  try{
    await userDAL.updateUserPassword(userID, hashedPassword);
  } catch(error){
    if(isAxiosError(error)){
      throw (error)
    }
    throw new AxiosError(UserErrorMessages.UPDATE_USER_PASSWORD_FAILED, UserErrorCodes.UPDATE_USER_PASSWORD_FAILED);
  }
}

export const updateUserById = async (userId: string, updateUserDto: UpdateUserDto, opts: { candidatesOnly?: boolean } = {}) => {
  try{
    if (opts.candidatesOnly) {
      const target = await userDAL.findUserById(userId);
      if (!target || target.role !== UserRole.USER) return null;
    }
    if (updateUserDto.cvFileUrl) {
      const cvKey = await claimCvUpload(updateUserDto.cvFileUrl, userId);
      if (cvKey) {
        updateUserDto.cvFileUrl = cvKey;
      } else {
        delete updateUserDto.cvFileUrl;
      }
    }
    const updatedUser = await userDAL.updateUserById(userId, updateUserDto, opts);
    if (updatedUser) {
      await salesforceService.updateContact(updatedUser ,userId);
      if (updateUserDto.cvFileUrl) {
        await salesforceService.uploadCVFromS3ToSalesforce(updateUserDto.cvFileUrl, updatedUser.id.toString());   
      }
    }
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
 * Salesforce sync failures are logged, not thrown (the DB change stands).
 */
export const setProfileCv = async (userId: string, key: string): Promise<void> => {
  const updatedUser = await userDAL.updateUserById(userId, { cvFileUrl: key });
  if (!updatedUser) {
    throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
  }
  try {
    await salesforceService.updateContact(updatedUser, userId);
    await salesforceService.uploadCVFromS3ToSalesforce(key, userId);
  } catch (error) {
    console.error('[salesforce] profile CV sync failed for a user', (error as Error)?.message);
  }
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

// Compare passwords using the hash service
export const compareUserPassword = async (userId: string, inputPassword: string): Promise<boolean> => {
  const user = await userDAL.findUserById(userId);
  if (!user){
    throw new AxiosError(UserErrorMessages.USER_NOT_FOUND, UserErrorCodes.USER_NOT_FOUND);
  } 

  return comparePassword(inputPassword, user.password);
}

/** Does another account already use this phone number? (a candidate changing their own phone) */
export const phoneTakenByOther = async (phoneNumber: string, userId: string): Promise<boolean> => {
  const other = await userDAL.findUserByPhoneNumber(phoneNumber);
  return !!other && String(other.id ?? other._id) !== String(userId);
};
