import { type RequestHandler, Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { ChatController } from './chat.controller.js';
import { chatHistoryRequestSchema } from './chat.schemas.js';

export const createChatRouter = (
  controller: ChatController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post('/chat/websocket-tickets', requireAuthenticatedUser, controller.issueTicket);
  router.get(
    '/events/:eventId/chat/messages',
    requireAuthenticatedUser,
    validate(chatHistoryRequestSchema),
    controller.history,
  );
  return router;
};
