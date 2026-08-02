import { Router } from 'express';

import { requireRequestUser } from '../../shared/http/request-user.middleware.js';
import { validate } from '../../shared/validation/validate.middleware.js';
import type { ReservationsController } from './reservations.controller.js';
import { eventAttendanceRequestSchema } from './reservations.schemas.js';

export const createReservationsRouter = (controller: ReservationsController): Router => {
  const router = Router();
  const middleware = [requireRequestUser, validate(eventAttendanceRequestSchema)] as const;

  router.post('/events/:eventId/reservations', ...middleware, controller.reserve);
  router.get('/events/:eventId/reservations/me', ...middleware, controller.getMine);
  router.delete('/events/:eventId/reservations/me', ...middleware, controller.cancelMine);
  router.get('/events/:eventId/waitlist/me', ...middleware, controller.getMyWaitlist);
  router.delete('/events/:eventId/waitlist/me', ...middleware, controller.cancelMyWaitlist);

  return router;
};
