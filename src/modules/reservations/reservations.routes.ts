import { type RequestHandler, Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { ReservationsController } from './reservations.controller.js';
import { eventAttendanceRequestSchema } from './reservations.schemas.js';

export const createReservationsRouter = (
  controller: ReservationsController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  const middleware = [requireAuthenticatedUser, validate(eventAttendanceRequestSchema)] as const;

  router.post('/events/:eventId/reservations', ...middleware, controller.reserve);
  router.get('/events/:eventId/reservations/me', ...middleware, controller.getMine);
  router.delete('/events/:eventId/reservations/me', ...middleware, controller.cancelMine);
  router.get('/events/:eventId/waitlist/me', ...middleware, controller.getMyWaitlist);
  router.delete('/events/:eventId/waitlist/me', ...middleware, controller.cancelMyWaitlist);

  return router;
};
