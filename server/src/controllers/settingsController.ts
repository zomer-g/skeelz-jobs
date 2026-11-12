import { NextFunction, Request, Response } from 'express';
import { AxiosError } from 'axios';
import { GlobalErrorCodes, GlobalErrorMessages } from '../i18n/i18n.js';
import * as settingsService from '../services/settingsService.js';
import { ApplyPolicy } from '../models/schemas/applyPolicy.js';
import { actorOf, writeAudit } from '../security/audit.js';

const POLICY_FIELDS: (keyof ApplyPolicy)[] = ['quickApply', 'quickApplyWithoutCv'];

/** GET /admin/settings/apply-policy — the site-wide defaults. */
export const getApplyPolicy = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await settingsService.getApplyPolicyDefaults() });
  } catch (error) {
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};

/** PUT /admin/settings/apply-policy — body: { quickApply?: boolean, quickApplyWithoutCv?: boolean }. */
export const updateApplyPolicy = async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  const valid = keys.length > 0 && keys.every((k) => POLICY_FIELDS.includes(k as keyof ApplyPolicy) && typeof body[k] === 'boolean');
  if (!valid) {
    return next(new AxiosError(GlobalErrorMessages.ILLEGAL_ARGUMENT, GlobalErrorCodes.ILLEGAL_ARGUMENT));
  }
  try {
    const value = await settingsService.updateApplyPolicyDefaults(body as Partial<ApplyPolicy>, req.authJwtPayload?.userID);
    void writeAudit(actorOf(req), 'settings.apply_policy_updated', 'applyPolicy', body);
    res.json({ data: value });
  } catch (error) {
    console.error('[settings] update failed', (error as Error).message);
    next(new AxiosError(GlobalErrorMessages.GENERAL_ERROR, GlobalErrorCodes.GENERAL_ERROR));
  }
};
