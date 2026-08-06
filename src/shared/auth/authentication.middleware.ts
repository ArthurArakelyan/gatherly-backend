import type { RequestHandler, Response } from 'express';

import type { IdentityService } from '../../modules/identity/identity.service.js';
import type { AuthenticatedUser } from '../../modules/identity/identity.types.js';
import { AppError } from '../errors/app-error.js';

const readBearerToken = (authorization: string | undefined): string => {
  if (authorization === undefined) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }

  const [scheme, token, extra] = authorization.split(' ');
  if (scheme !== 'Bearer' || token === undefined || token === '' || extra !== undefined) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }
  return token;
};

export const createRequireAuthenticatedUser = (
  identityService: IdentityService,
): RequestHandler => {
  return async (request, response, next) => {
    try {
      const token = readBearerToken(request.headers.authorization);
      response.locals['authenticatedUser'] = await identityService.authenticateAccessToken(token);
      next();
    } catch (error) {
      next(error);
    }
  };
};

export const getAuthenticatedUser = (response: Response): AuthenticatedUser => {
  const user: unknown = response.locals['authenticatedUser'];
  if (typeof user !== 'object' || user === null || !('id' in user) || typeof user.id !== 'string') {
    throw new AppError(500, 'INTERNAL_ERROR', 'Authentication middleware was not applied');
  }
  return user as AuthenticatedUser;
};
