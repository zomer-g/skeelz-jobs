import { NextFunction, Request, Response } from 'express';
import * as userService  from '../services/userService.js';
import { CreateUserDto } from '../dto/createUserDto.js';
import { UpdateUserDto } from '../dto/updateUserDto.js';
import { usersFilter } from '../models/interfaces/general.interface.js';
import { UserErrorCodes, UserErrorMessages } from '../i18n/i18n.js';
import { AxiosError, isAxiosError } from 'axios';


import { generateAndStoreRefreshToken } from '../services/authService.js';
import { generateAccessToken } from '../services/tokenUtilityService.js';
import { setAccessTokenInCookies, setRefreshTokenInCookies } from '../utils/authUtils.js';
import { parseBoolean } from '../utils/utils.js';
import { peopleHandover } from '../security/handover.js';
import { AuditWriteError, actorOf, writeAudit } from '../security/audit.js';
import { LimitError } from '../middleware/errorMiddleware.js';
import { safeErrorText } from '../security/pure.js';

  export const fetchUsers = async (req: Request, res: Response, next: NextFunction) => {
    // Optional on the client; without it this threw outside the try and killed the process.
    const queryUsersFilter = (req.query.usersFilter ?? {}) as usersFilter;

    const usersFilterParams: usersFilter = {
      ...queryUsersFilter,
      hasApplied: parseBoolean(queryUsersFilter.hasApplied),
    };
    try {
      let total = 0;
      // Every candidate shown is recorded (strict) and counted in the content manager's daily limit.
      const { rows: users, cut } = await peopleHandover({
        who: actorOf(req),
        action: 'candidates.shown',
        place: 'GET /api/users',
        details: {
          filters: {
            search: usersFilterParams.inputValue || undefined,
            hasCv: usersFilterParams.hasCv || undefined,
            hasApplied: usersFilterParams.hasApplied || undefined,
            sort: usersFilterParams.sortField ? `${usersFilterParams.sortField} ${usersFilterParams.sortOrder ?? ''}`.trim() : undefined,
          },
          page: Number(usersFilterParams.page || 1),
          limit: Number(usersFilterParams.limit || 0) || undefined,
        },
        load: async () => {
          const r = await userService.fetchAllUsers(usersFilterParams);
          total = r.total;
          return r.users;
        },
        idOf: (u) => String(u._id),
      });
      return res.json({ data: { users, total, cut } });
    } catch (error) {
      if (error instanceof AuditWriteError || error instanceof LimitError) return next(error);
      console.error('[users] list failed', safeErrorText(error));
      next(new AxiosError(UserErrorMessages.FETCH_FAILED, UserErrorCodes.FETCH_FAILED));
    }
  };


  export const createUser = async (req: Request, res: Response,next:NextFunction) => {
    try {
      const createUserDto: CreateUserDto = req.body;
      const newUser = await userService.createUser(createUserDto);
      if(newUser){
        const userID = newUser._id.toString();
        const accessToken = generateAccessToken({ userID, userRole: newUser.user.role });
        const refreshToken = await generateAndStoreRefreshToken({ userID, userRole: newUser.user.role });
        setAccessTokenInCookies(res,accessToken);
        setRefreshTokenInCookies(res,refreshToken);
        void writeAudit(`user:${userID}`, 'user.signed_up', userID, { has_cv: !!newUser.user.cvFileUrl });
      }
      return res.json({data:{
        _id: newUser._id,
        user: newUser.user,
    }});
      
    } catch (error) {
      console.error(error);
      if (isAxiosError(error)) {
      return next(error)
      }
        next(new AxiosError(UserErrorMessages.CREATE_USER_FAILED, UserErrorCodes.CREATE_USER_FAILED));
    }
  };

  export const updateUser = async (req: Request, res: Response,next:NextFunction): Promise<void> => {
  try {
    const userId = req.params.id; 
    const updateUserDto: UpdateUserDto = req.body;

    // Content managers edit candidates only; staff accounts are the admins' (staff users screen).
    const updatedUser = await userService.updateUserById(userId, updateUserDto, { candidatesOnly: true });

    if (updatedUser) {
      // Which fields changed, never their values.
      void writeAudit(actorOf(req), 'user.updated', String(updatedUser._id), {
        ids: [String(updatedUser._id)], fields: Object.keys(updateUserDto ?? {}).filter((k) => k !== 'password').slice(0, 30),
      });
      res.status(200).json({ data: {
        message: 'User updated successfully',
        userId: updatedUser._id,
      }});
    } else {
      next(new AxiosError(UserErrorMessages. USER_NOT_FOUND, UserErrorCodes. USER_NOT_FOUND));
    }
  } catch (error) {
      console.error(error);
      if (isAxiosError(error)) {
      return next(error)
      }
      next(new AxiosError(UserErrorMessages.UPDATE_USER_FAILED, UserErrorCodes.UPDATE_USER_FAILED));
  }
};

