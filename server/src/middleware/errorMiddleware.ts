import { Request, Response, NextFunction } from 'express';
import { isAxiosError } from 'axios';
import { GlobalErrorCodes, GlobalErrorMessages } from '../i18n/i18n.js';
import { AuditWriteError } from '../security/audit.js';
import { safeErrorText } from '../security/pure.js';

/** A daily limit was reached (429, with a message that says an admin was told). */
export class LimitError extends Error {
  constructor(message: string, public budget: string) { super(message); this.name = 'LimitError'; }
}

export const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof AuditWriteError) {
        // No record → no hand-over of personal data.
        return res.status(503).json({ message: 'יומן הפעילות אינו זמין כרגע, ולכן המידע לא נמסר. נסו שוב בעוד רגע.', code: 'audit_unavailable' });
    }
    if (err instanceof LimitError) {
        return res.status(429).json({ message: err.message, code: `limit_${err.budget}` });
    }
    // Expected refusals (AxiosError with our codes) need no stack; everything else prints safely.
    if (!isAxiosError(err)) console.error(`[error] ${req.method} ${req.path}: ${safeErrorText(err)}`);
    if (isAxiosError(err)) {
        return res.status(400).json({ message: err.message, code: err.code });
    }
    return res.status(500).json({ message:GlobalErrorMessages.GENERAL_ERROR, code:GlobalErrorCodes.GENERAL_ERROR });
}
