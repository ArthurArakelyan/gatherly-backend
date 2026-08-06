import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import { AppError } from '../../shared/errors/app-error.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { IdentityController } from './identity.controller.js';
import { signInRequestSchema, signUpRequestSchema } from './identity.schemas.js';

export const createIdentityRouter = (
  controller: IdentityController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  const signInLimiter = rateLimit({
    windowMs: 15 * 60 * 1_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, 'SIGN_IN_RATE_LIMITED', 'Try signing in again later'));
    },
  });
  const signUpLimiter = rateLimit({
    windowMs: 60 * 60 * 1_000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new AppError(429, 'SIGN_UP_RATE_LIMITED', 'Try creating an account again later'));
    },
  });

  router.post('/sign-up', signUpLimiter, validate(signUpRequestSchema), controller.signUp);
  router.post('/sign-in', signInLimiter, validate(signInRequestSchema), controller.signIn);
  router.get('/me', requireAuthenticatedUser, controller.me);
  return router;
};
