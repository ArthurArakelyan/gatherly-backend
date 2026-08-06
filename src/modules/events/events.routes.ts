import { type RequestHandler, Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { EventsController } from './events.controller.js';
import {
  createEventRequestSchema,
  getEventRequestSchema,
  listEventsRequestSchema,
} from './events.schemas.js';

export const createEventsRouter = (
  controller: EventsController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post(
    '/communities/:communityId/events',
    requireAuthenticatedUser,
    validate(createEventRequestSchema),
    controller.create,
  );
  router.get('/events', validate(listEventsRequestSchema), controller.list);
  router.get('/events/:eventId', validate(getEventRequestSchema), controller.get);
  return router;
};
