import type { RequestHandler } from 'express';
import { z } from 'zod';

import { ExpressSseStream } from '../../infrastructure/http/express-sse-stream.js';
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { RealtimeService } from './realtime.service.js';

const lastEventIdSchema = z.string().regex(/^\d{1,19}$/);
const maximumEventId = 9_223_372_036_854_775_807n;

const parseLastEventId = (value: string | undefined): bigint => {
  if (value === undefined || value === '') return 0n;
  const parsed = lastEventIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID is invalid');
  }
  const eventId = BigInt(parsed.data);
  if (eventId > maximumEventId) {
    throw new AppError(400, 'INVALID_LAST_EVENT_ID', 'Last-Event-ID is invalid');
  }
  return eventId;
};

export class RealtimeController {
  public constructor(private readonly service: RealtimeService) {}

  public readonly stream: RequestHandler = async (request, response) => {
    const afterId = parseLastEventId(request.header('Last-Event-ID'));
    const userId = getAuthenticatedUser(response).id;
    await this.service.connect(userId, afterId, new ExpressSseStream(response));
  };
}
