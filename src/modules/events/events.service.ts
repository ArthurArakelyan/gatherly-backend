import { AppError } from '../../shared/errors/app-error.js';
import type { EventCache } from './events.cache.js';
import type { EventsRepository } from './events.repository.js';
import type {
  CreateEventInput,
  Event,
  EventFilters,
  EventPage,
  EventSearchProjection,
} from './events.types.js';

const creationRoles = new Set(['OWNER', 'ORGANIZER', 'MODERATOR']);

export class EventsService {
  public constructor(
    private readonly repository: EventsRepository,
    private readonly cache?: EventCache,
    private readonly searchProjection?: EventSearchProjection,
  ) {}

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    const authorization = await this.repository.findCreationAuthorization(communityId, userId);

    if (authorization?.communityStatus !== 'ACTIVE') {
      throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
    }
    if (
      authorization.membershipStatus !== 'ACTIVE' ||
      authorization.role === null ||
      !creationRoles.has(authorization.role)
    ) {
      throw new AppError(403, 'COMMUNITY_PERMISSION_DENIED', 'You cannot create events here');
    }
    if (input.startsAt >= input.endsAt) {
      throw new AppError(400, 'INVALID_EVENT_TIME', 'Event end must be after its start');
    }

    const event = await this.repository.create(communityId, userId, input);
    this.searchProjection?.schedule(event.id);
    return event;
  }

  public list(filters: EventFilters): Promise<EventPage> {
    return this.repository.listPublic(filters);
  }

  public async get(eventId: string): Promise<Event> {
    const cachedEvent = await this.cache?.get(eventId);
    if (cachedEvent !== null && cachedEvent !== undefined) return cachedEvent;

    const event = await this.repository.findPublicById(eventId);
    if (event === null) {
      throw new AppError(404, 'EVENT_NOT_FOUND', 'The requested event does not exist');
    }

    await this.cache?.set(event);
    return event;
  }
}
