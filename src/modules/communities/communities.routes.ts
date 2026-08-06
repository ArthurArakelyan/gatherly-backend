import { type RequestHandler, Router } from 'express';
import { validate } from '../../shared/validation/validate.middleware.js';
import {
  createCommunityRequestSchema,
  getCommunityRequestSchema,
  listCommunitiesRequestSchema,
} from './communities.schemas.js';
import type { CommunitiesController } from './communities.controller.js';

export const createCommunitiesRouter = (
  controller: CommunitiesController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post(
    '/',
    requireAuthenticatedUser,
    validate(createCommunityRequestSchema),
    controller.create,
  );
  router.get('/', validate(listCommunitiesRequestSchema), controller.list);
  router.get('/:communityId', validate(getCommunityRequestSchema), controller.get);
  return router;
};
