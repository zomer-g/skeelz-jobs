import { Request } from 'express';
import { IAuthJwtPayload } from '../interfaces/general.interface.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by the auth middleware. userRole is the role in the DB NOW, not the one in the token. */
      authJwtPayload?: IAuthJwtPayload;
      /** The signed-in person as read from the DB on this request. */
      authUser?: { id: string; email: string; role: string };
      /** Set by internalApiAuth (internal API only): the token or the server secret that called. */
      apiClient?: { kind: 'token' | 'secret'; id: string; name: string; scopes: string[]; actor: string };
    }
  }
}
