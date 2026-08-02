import type { RequestHandler } from 'express';
import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';
import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { EventAttendanceRequest } from './reservations.schemas.js';
import type { ReservationsService } from './reservations.service.js';

const idempotencyKeySchema = z.string().min(1).max(200);

export class ReservationsController {
  public constructor(private readonly service: ReservationsService) {}

  public readonly reserve: RequestHandler = async (request, response) => {
    const parsedKey = idempotencyKeySchema.safeParse(request.header('Idempotency-Key'));
    if (!parsedKey.success) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required');
    }

    const { params } = getValidated<EventAttendanceRequest>(response);
    const result = await this.service.reserve(
      params.eventId,
      getRequestUserId(response),
      parsedKey.data,
    );
    response.status(result.status).json({ data: result.body });
  };

  public readonly getMine: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getReservation(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, reservedAt: value.reservedAt.toISOString() } });
  };

  public readonly cancelMine: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    await this.service.cancelReservation(params.eventId, getRequestUserId(response));
    response.status(204).send();
  };

  public readonly getMyWaitlist: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    const value = await this.service.getWaitlistEntry(params.eventId, getRequestUserId(response));
    response.json({ data: { ...value, joinedAt: value.joinedAt.toISOString() } });
  };

  public readonly cancelMyWaitlist: RequestHandler = async (_request, response) => {
    const { params } = getValidated<EventAttendanceRequest>(response);
    await this.service.cancelWaitlist(params.eventId, getRequestUserId(response));
    response.status(204).send();
  };
}
