import { type RequestHandler, Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { MembershipsController } from './memberships.controller.js';
import { communityMembershipRequestSchema } from './memberships.schemas.js';

export const createMembershipsRouter = (
  controller: MembershipsController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post(
    '/:communityId/join',
    requireAuthenticatedUser,
    validate(communityMembershipRequestSchema),
    controller.join,
  );
  router.post(
    '/:communityId/leave',
    requireAuthenticatedUser,
    validate(communityMembershipRequestSchema),
    controller.leave,
  );
  return router;
};
