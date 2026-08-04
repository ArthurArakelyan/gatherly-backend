import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  CreateEventInput,
  Event,
  EventCreationAuthorization,
  EventFilters,
  EventFormat,
  EventPage,
  EventVisibility,
} from './events.types.js';

const eventSelection = {
  id: true,
  communityId: true,
  createdByUserId: true,
  title: true,
  slug: true,
  description: true,
  format: true,
  status: true,
  visibility: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  capacity: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EventSelect;

type EventRecord = Prisma.EventGetPayload<{ select: typeof eventSelection }>;

const mapEvent = (record: EventRecord): Event => ({
  ...record,
  format: record.format as EventFormat,
  visibility: record.visibility as EventVisibility,
});

export class EventsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findCreationAuthorization(
    communityId: string,
    userId: string,
  ): Promise<EventCreationAuthorization | null> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        status: true,
        memberships: {
          where: { userId },
          select: { status: true, role: true },
          take: 1,
        },
      },
    });

    if (community === null) return null;
    const membership = community.memberships[0];
    return {
      communityStatus: community.status,
      membershipStatus: membership?.status ?? null,
      role: membership?.role ?? null,
    };
  }

  public async create(
    communityId: string,
    userId: string,
    input: CreateEventInput,
  ): Promise<Event> {
    try {
      const record = await this.prisma.event.create({
        data: {
          communityId,
          createdByUserId: userId,
          title: input.title,
          slug: input.slug,
          description: input.description,
          format: input.format,
          visibility: input.visibility,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: input.timezone,
          capacity: input.capacity,
        },
        select: eventSelection,
      });
      return mapEvent(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'EVENT_SLUG_TAKEN', 'That event slug is already used here');
      }
      throw error;
    }
  }

  public async findPublicById(eventId: string): Promise<Event | null> {
    const record = await this.prisma.event.findFirst({
      where: {
        id: eventId,
        visibility: 'PUBLIC',
        status: { in: ['PUBLISHED', 'CANCELLED', 'COMPLETED'] },
        community: { status: 'ACTIVE' },
      },
      select: eventSelection,
    });
    return record === null ? null : mapEvent(record);
  }

  public async listPublic(filters: EventFilters): Promise<EventPage> {
    const where: Prisma.EventWhereInput = {
      visibility: 'PUBLIC',
      status: filters.status ?? { in: ['PUBLISHED', 'CANCELLED', 'COMPLETED'] },
      community: { status: 'ACTIVE' },
      ...(filters.communityId === null ? {} : { communityId: filters.communityId }),
      ...(filters.startsAfter === null ? {} : { startsAt: { gte: filters.startsAfter } }),
      ...(filters.startsBefore === null
        ? {}
        : {
            startsAt: {
              ...(filters.startsAfter === null ? {} : { gte: filters.startsAfter }),
              lt: filters.startsBefore,
            },
          }),
    };

    const [records, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        select: eventSelection,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.event.count({ where }),
    ]);

    return {
      items: records.map(mapEvent),
      page: filters.page,
      limit: filters.limit,
      total,
    };
  }
}
