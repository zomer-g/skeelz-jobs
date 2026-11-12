import { AxiosError } from 'axios';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { Request, Response, NextFunction } from 'express';
import { GlobalErrorCodes, GlobalErrorMessages } from '../i18n/i18n.js';

export function validationMiddleware<T extends object>(type: new (...args: any[]) => T): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Transform plain request body to instance of DTO class
      const dtoObject = plainToInstance(type, req.body);

      // Validate the object
      const errors: ValidationError[] = await validate(dtoObject, { whitelist: true, forbidNonWhitelisted: true });

      // Check if there are validation errors
      if (errors.length > 0) {
        // Extract error messages in a structured way
        const errorMessages = errors.map(error => ({
          field: error.property,
          constraints: error.constraints,
        }));

        // Log the validation error details using JSON.stringify to handle nested objects
        console.error('Validation failed', JSON.stringify({ errors: errorMessages }, null, 2));

        // Pass the validation error details as a structured error to next() 
        return next(new AxiosError(GlobalErrorMessages.ILLEGAL_ARGUMENT, GlobalErrorCodes.ILLEGAL_ARGUMENT));
      }

      // Update request body with validated DTO object, omitting non-whitelisted fields
      req.body = dtoObject;

      // Continue to the next middleware
      next();
    } catch (err) {
      console.error('Unexpected error in validation middleware', { err });
      next(err); // Pass unexpected errors to the global error handler
    }
  };
}
