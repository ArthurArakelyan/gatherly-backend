import { type RequestHandler, Router } from 'express';

import type { RealtimeController } from './realtime.controller.js';

export const createRealtimeRouter = (
  controller: RealtimeController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.get('/realtime/stream', requireAuthenticatedUser, controller.stream);
  return router;
};
