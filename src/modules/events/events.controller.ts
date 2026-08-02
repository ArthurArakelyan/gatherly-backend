import type { RequestHandler } from 'express';

import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { CreateEventRequest, GetEventRequest, ListEventsRequest } from './events.schemas.js';
import type { EventsService } from './events.service.js';
import type { Event } from './events.types.js';

interface EventDto {
  id: string;
  communityId: string;
  createdByUserId: string;
  title: string;
  slug: string;
  description: string;
  format: string;
  status: string;
  visibility: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number;
  createdAt: string;
  updatedAt: string;
}

const toEventDto = (event: Event): EventDto => ({
  id: event.id,
  communityId: event.communityId,
  createdByUserId: event.createdByUserId,
  title: event.title,
  slug: event.slug,
  description: event.description,
  format: event.format,
  status: event.status,
  visibility: event.visibility,
  startsAt: event.startsAt.toISOString(),
  endsAt: event.endsAt.toISOString(),
  timezone: event.timezone,
  capacity: event.capacity,
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

export class EventsController {
  public constructor(private readonly service: EventsService) {}

  public readonly create: RequestHandler = async (_request, response) => {
    const { body, params } = getValidated<CreateEventRequest>(response);
    const event = await this.service.create(params.communityId, getRequestUserId(response), body);
    response.status(201).json({ data: toEventDto(event) });
  };

  public readonly list: RequestHandler = async (_request, response) => {
    const { query } = getValidated<ListEventsRequest>(response);
    const page = await this.service.list(query);
    response.json({
      data: page.items.map(toEventDto),
      pagination: { page: page.page, limit: page.limit, total: page.total },
    });
  };

  public readonly get: RequestHandler = async (_request, response) => {
    const { params } = getValidated<GetEventRequest>(response);
    response.json({ data: toEventDto(await this.service.get(params.eventId)) });
  };
}
