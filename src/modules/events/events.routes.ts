import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { EventsController } from './events.controller.js';
import {
  createEventRequestSchema,
  getEventRequestSchema,
  listEventsRequestSchema,
} from './events.schemas.js';

export const createEventsRouter = (controller: EventsController): Router => {
  const router = Router();
  router.post(
    '/communities/:communityId/events',
    requireRequestUser,
    validate(createEventRequestSchema),
    controller.create,
  );
  router.get('/events', validate(listEventsRequestSchema), controller.list);
  router.get('/events/:eventId', validate(getEventRequestSchema), controller.get);
  return router;
};
