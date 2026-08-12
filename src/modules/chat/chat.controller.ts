import type { RequestHandler } from 'express';

import type { WebSocketTicketStore } from '../../infrastructure/redis/websocket-ticket-store.js';
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { ChatService } from './chat.service.js';
import type { ChatHistoryRequest } from './chat.schemas.js';

export class ChatController {
  public constructor(
    private readonly service: ChatService,
    private readonly tickets: WebSocketTicketStore,
  ) {}

  public readonly issueTicket: RequestHandler = async (_request, response) => {
    const result = await this.tickets.issue(getAuthenticatedUser(response));
    response.status(201).json({ data: result });
  };

  public readonly history: RequestHandler = async (_request, response) => {
    const { params, query } = getValidated<ChatHistoryRequest>(response);
    const page = await this.service.history(
      params.eventId,
      getAuthenticatedUser(response).id,
      query.cursor,
      query.limit,
    );
    response.status(200).json({ data: page.items, pagination: { nextCursor: page.nextCursor } });
  };
}
