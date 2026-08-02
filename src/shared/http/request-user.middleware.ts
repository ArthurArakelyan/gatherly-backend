import type { RequestHandler, Response } from 'express';
import { z } from 'zod';

import { AppError } from '../errors/app-error.js';

const userIdSchema = z.uuid();

export const requireRequestUser: RequestHandler = (request, response, next) => {
  const result = userIdSchema.safeParse(request.headers['x-user-id']);

  if (!result.success) {
    next(new AppError(401, 'USER_REQUIRED', 'A valid x-user-id header is required'));
    return;
  }

  response.locals['userId'] = result.data;
  next();
};

export const getRequestUserId = (response: Response): string => {
  const userId: unknown = response.locals['userId'];

  if (typeof userId !== 'string') {
    throw new AppError(500, 'INTERNAL_ERROR', 'Request user middleware was not applied');
  }

  return userId;
};
