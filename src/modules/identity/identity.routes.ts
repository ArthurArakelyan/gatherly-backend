import { Router, type RequestHandler } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { IdentityController } from './identity.controller.js';
import { signInRequestSchema, signUpRequestSchema } from './identity.schemas.js';
import type { IdentityRateLimiters } from './identity.types.js';

export const createIdentityRouter = (
  controller: IdentityController,
  requireAuthenticatedUser: RequestHandler,
  rateLimiters: IdentityRateLimiters,
): Router => {
  const router = Router();
  router.post('/sign-up', rateLimiters.signUp, validate(signUpRequestSchema), controller.signUp);
  router.post('/sign-in', rateLimiters.signIn, validate(signInRequestSchema), controller.signIn);
  router.get('/me', requireAuthenticatedUser, controller.me);
  return router;
};
