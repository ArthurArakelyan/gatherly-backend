import { type Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import type { EventSearchDocument, SearchableEventFormat } from './search.types.js';

const projectionSelection = {
  id: true,
  title: true,
  description: true,
  format: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  updatedAt: true,
  community: {
    select: {
      id: true,
      name: true,
      slug: true,
      city: true,
      country: true,
    },
  },
} satisfies Prisma.EventSelect;

type ProjectionRecord = Prisma.EventGetPayload<{ select: typeof projectionSelection }>;

const eligibleWhere = {
  visibility: 'PUBLIC',
  status: 'PUBLISHED',
  community: { status: 'ACTIVE' },
} satisfies Prisma.EventWhereInput;

const mapProjection = (record: ProjectionRecord): EventSearchDocument => ({
  id: record.id,
  communityId: record.community.id,
  communityName: record.community.name,
  communitySlug: record.community.slug,
  communityCity: record.community.city,
  communityCountry: record.community.country,
  title: record.title,
  description: record.description,
  format: record.format as SearchableEventFormat,
  startsAt: record.startsAt.toISOString(),
  endsAt: record.endsAt.toISOString(),
  timezone: record.timezone,
  updatedAt: record.updatedAt.toISOString(),
});

export class EventSearchSourceRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findEligibleById(eventId: string): Promise<EventSearchDocument | null> {
    const record = await this.prisma.event.findFirst({
      where: { id: eventId, ...eligibleWhere },
      select: projectionSelection,
    });
    return record === null ? null : mapProjection(record);
  }

  public countEligible(): Promise<number> {
    return this.prisma.event.count({ where: eligibleWhere });
  }

  public async *iterateEligible(batchSize = 500): AsyncGenerator<EventSearchDocument> {
    let cursor: string | undefined;

    for (;;) {
      const records = await this.prisma.event.findMany({
        where: eligibleWhere,
        select: projectionSelection,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });

      if (records.length === 0) return;
      for (const record of records) yield mapProjection(record);

      const [lastRecord] = records.slice(-1);
      if (lastRecord === undefined) return;
      cursor = lastRecord.id;
      if (records.length < batchSize) return;
    }
  }
}
