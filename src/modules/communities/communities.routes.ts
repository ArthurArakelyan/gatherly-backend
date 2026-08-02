import { Router } from 'express';
import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import {
  createCommunityRequestSchema,
  getCommunityRequestSchema,
  listCommunitiesRequestSchema,
} from './communities.schemas.js';
import type { CommunitiesController } from './communities.controller.js';

export const createCommunitiesRouter = (controller: CommunitiesController): Router => {
  const router = Router();
  router.post('/', requireRequestUser, validate(createCommunityRequestSchema), controller.create);
  router.get('/', validate(listCommunitiesRequestSchema), controller.list);
  router.get('/:communityId', validate(getCommunityRequestSchema), controller.get);
  return router;
};
