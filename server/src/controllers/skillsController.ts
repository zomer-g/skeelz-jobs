import { NextFunction, Request, Response } from 'express';
import * as skillsService  from '../services/skillsService.js';
import { AxiosError, isAxiosError } from 'axios';
import { SkillsErrorCodes, SkillsErrorMessages } from '../i18n/i18n.js';

  export const fetchSkills = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const skills = await skillsService.fetchAllSkills();
      return res.json({ data: {skills} });
    } catch (error) {
      if (isAxiosError(error)) {
      return next(error)
      }
      next(new AxiosError(SkillsErrorMessages.FETCH_FAILED, SkillsErrorCodes.FETCH_FAILED));
    }
  };

