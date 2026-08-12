import { Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { SearchController } from './search.controller.js';
import { searchEventsRequestSchema, suggestEventsRequestSchema } from './search.schemas.js';

export const createSearchRouter = (controller: SearchController): Router => {
  const router = Router();
  router.get('/search/events', validate(searchEventsRequestSchema), controller.searchEvents);
  router.get(
    '/search/events/suggestions',
    validate(suggestEventsRequestSchema),
    controller.suggestEvents,
  );
  return router;
};
