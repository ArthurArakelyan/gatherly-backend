import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { MembershipsController } from './memberships.controller.js';
import { communityMembershipRequestSchema } from './memberships.schemas.js';

export const createMembershipsRouter = (controller: MembershipsController): Router => {
  const router = Router();
  router.post(
    '/:communityId/join',
    requireRequestUser,
    validate(communityMembershipRequestSchema),
    controller.join,
  );
  router.post(
    '/:communityId/leave',
    requireRequestUser,
    validate(communityMembershipRequestSchema),
    controller.leave,
  );
  return router;
};
