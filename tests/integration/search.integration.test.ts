import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pino from 'pino';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_SEARCH_READ_ALIAS,
  EVENT_SEARCH_WRITE_ALIAS,
} from '../../src/infrastructure/elasticsearch/event-index-definition.js';
import { EventSearchIndex } from '../../src/infrastructure/elasticsearch/event-search-index.js';
import { BestEffortEventSearchProjector } from '../../src/modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../../src/modules/search/event-search-source.repository.js';
import { SearchRepository } from '../../src/modules/search/search.repository.js';
import { SearchService } from '../../src/modules/search/search.service.js';
import { aliceId, createCommunityFixture } from '../fixtures/database.js';
import { type ElasticsearchHarness, startElasticsearchHarness } from '../helpers/elasticsearch.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { createTestApp } from '../helpers/test-app.js';

interface SearchEventFixture {
  title: string;
  description?: string;
  format?: 'IN_PERSON' | 'ONLINE' | 'HYBRID';
  status?: 'DRAFT' | 'PUBLISHED' | 'CANCELLED' | 'COMPLETED' | 'ARCHIVED';
  visibility?: 'PUBLIC' | 'COMMUNITY_ONLY' | 'INVITE_ONLY';
  startsAt?: string;
}

const logger = pino({ enabled: false });

const createSearchEvent = async (
  pool: Pool,
  communityId: string,
  fixture: SearchEventFixture,
): Promise<string> => {
  const id = randomUUID();
  const startsAt = fixture.startsAt ?? '2030-08-03T18:00:00.000Z';
  await pool.query(
    `INSERT INTO events
       (id, community_id, created_by_user_id, title, slug, description, format,
        status, visibility, starts_at, ends_at, timezone, capacity)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz,
        $10::timestamptz + interval '2 hours', 'Europe/Moscow', 10)`,
    [
      id,
      communityId,
      aliceId,
      fixture.title,
      `event-${id}`,
      fixture.description ?? '',
      fixture.format ?? 'IN_PERSON',
      fixture.status ?? 'PUBLISHED',
      fixture.visibility ?? 'PUBLIC',
      startsAt,
    ],
  );
  return id;
};

const configureCommunity = async (
  pool: Pool,
  communityId: string,
  values: { name: string; city: string | null; country: string | null },
): Promise<void> => {
  await pool.query(
    `UPDATE communities
     SET name = $2, city = $3, country = $4, updated_at = now()
     WHERE id = $1`,
    [communityId, values.name, values.city, values.country],
  );
};

describe('Elasticsearch event discovery integration', () => {
  let postgres: PostgresHarness;
  let elasticsearch: ElasticsearchHarness;
  let source: EventSearchSourceRepository;
  let index: EventSearchIndex;
  let searchRepository: SearchRepository;
  let app: Express;

  beforeAll(async () => {
    [postgres, elasticsearch] = await Promise.all([
      startPostgresHarness(),
      startElasticsearchHarness(),
    ]);
    source = new EventSearchSourceRepository(postgres.prisma);
    index = new EventSearchIndex(elasticsearch.client, elasticsearch.indexPrefix, logger);
    searchRepository = new SearchRepository(elasticsearch.client, logger);
    app = createTestApp(postgres, {
      searchService: new SearchService(searchRepository),
    });
  }, 120_000);

  beforeEach(async () => {
    await Promise.all([postgres.reset(), elasticsearch.reset()]);
    await postgres.seed();
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), elasticsearch.stop()]);
  }, 30_000);

  it('builds a strict eligible projection and atomically replaces both aliases', async () => {
    const activeCommunityId = await createCommunityFixture(postgres.pool);
    await configureCommunity(postgres.pool, activeCommunityId, {
      name: 'Moscow Makers',
      city: 'Moscow',
      country: 'Russia',
    });
    const firstEligibleId = await createSearchEvent(postgres.pool, activeCommunityId, {
      title: 'Beginner pottery',
    });
    await createSearchEvent(postgres.pool, activeCommunityId, { title: 'Woodworking basics' });
    await createSearchEvent(postgres.pool, activeCommunityId, {
      title: 'Private event',
      visibility: 'COMMUNITY_ONLY',
    });
    await createSearchEvent(postgres.pool, activeCommunityId, {
      title: 'Draft event',
      status: 'DRAFT',
    });
    const archivedCommunityId = await createCommunityFixture(postgres.pool);
    await createSearchEvent(postgres.pool, archivedCommunityId, { title: 'Archived event' });
    await postgres.pool.query(`UPDATE communities SET status = 'ARCHIVED' WHERE id = $1`, [
      archivedCommunityId,
    ]);

    const streamed = [];
    for await (const document of source.iterateEligible(1)) streamed.push(document);
    expect(streamed.map((document) => document.title)).toEqual([
      'Beginner pottery',
      'Woodworking basics',
    ]);
    expect(await source.countEligible()).toBe(2);

    const firstBuild = await index.rebuild(source);
    expect(firstBuild.indexedDocuments).toBe(2);
    const [readAliases, writeAliases, mapping] = await Promise.all([
      elasticsearch.client.indices.getAlias({ name: EVENT_SEARCH_READ_ALIAS }),
      elasticsearch.client.indices.getAlias({ name: EVENT_SEARCH_WRITE_ALIAS }),
      elasticsearch.client.indices.getMapping({ index: firstBuild.index }),
    ]);
    expect(Object.keys(readAliases)).toEqual([firstBuild.index]);
    expect(Object.keys(writeAliases)).toEqual([firstBuild.index]);
    expect(mapping[firstBuild.index]?.mappings.dynamic).toBe('strict');

    const projected = await source.findEligibleById(firstEligibleId);
    expect(projected).not.toBeNull();
    await expect(
      elasticsearch.client.index({
        index: EVENT_SEARCH_WRITE_ALIAS,
        id: randomUUID(),
        document: { ...projected, unexpectedPrivateField: 'must be rejected' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const secondBuild = await index.rebuild(source);
    expect(secondBuild.index).not.toBe(firstBuild.index);
    expect(secondBuild.previousIndices).toContain(firstBuild.index);
    const [newReadAliases, newWriteAliases] = await Promise.all([
      elasticsearch.client.indices.getAlias({ name: EVENT_SEARCH_READ_ALIAS }),
      elasticsearch.client.indices.getAlias({ name: EVENT_SEARCH_WRITE_ALIAS }),
    ]);
    expect(Object.keys(newReadAliases)).toEqual([secondBuild.index]);
    expect(Object.keys(newWriteAliases)).toEqual([secondBuild.index]);
    expect(await elasticsearch.client.indices.exists({ index: firstBuild.index })).toBe(true);
  }, 20_000);

  it('supports typo search, exact filters, facets, suggestions, and PIT cursor pages', async () => {
    const moscowCommunityId = await createCommunityFixture(postgres.pool);
    await configureCommunity(postgres.pool, moscowCommunityId, {
      name: 'Moscow Makers',
      city: 'Moscow',
      country: 'Russia',
    });
    await createSearchEvent(postgres.pool, moscowCommunityId, {
      title: 'Beginner pottery workshop',
      description: 'A practical class for new makers',
      startsAt: '2030-08-03T18:00:00.000Z',
    });
    await createSearchEvent(postgres.pool, moscowCommunityId, {
      title: 'Advanced pottery glazing',
      startsAt: '2030-08-04T18:00:00.000Z',
    });

    const kazanCommunityId = await createCommunityFixture(postgres.pool);
    await configureCommunity(postgres.pool, kazanCommunityId, {
      name: 'Kazan Crafts',
      city: 'Kazan',
      country: 'Russia',
    });
    await createSearchEvent(postgres.pool, kazanCommunityId, {
      title: 'Woodworking basics',
      startsAt: '2030-08-05T18:00:00.000Z',
    });
    await createSearchEvent(postgres.pool, kazanCommunityId, {
      title: 'Remote TypeScript meetup',
      format: 'ONLINE',
      startsAt: '2030-08-06T18:00:00.000Z',
    });
    await index.rebuild(source);

    const typo = await request(app).get('/api/search/events').query({ q: 'potery' });
    expect(typo.status).toBe(200);
    expect(
      (typo.body as { data: { event: { title: string } }[] }).data.map((hit) => hit.event.title),
    ).toEqual(expect.arrayContaining(['Beginner pottery workshop', 'Advanced pottery glazing']));

    const filtered = await request(app).get('/api/search/events').query({
      q: 'pottery',
      format: 'IN_PERSON',
      city: 'Moscow',
    });
    expect(filtered.status).toBe(200);
    const filteredBody = filtered.body as {
      data: { event: { title: string } }[];
      facets: { formats: { value: string; count: number }[]; cities: { value: string }[] };
    };
    expect(filteredBody.data).toHaveLength(2);
    expect(filteredBody.facets.formats).toContainEqual({ value: 'IN_PERSON', count: 2 });
    expect(filteredBody.facets.cities).toEqual([{ value: 'Moscow', count: 2 }]);

    const suggestions = await request(app)
      .get('/api/search/events/suggestions')
      .query({ q: 'woodw' });
    expect(suggestions.status).toBe(200);
    expect(
      (suggestions.body as { data: { title: string }[] }).data.map((item) => item.title),
    ).toContain('Woodworking basics');

    const seenIds = new Set<string>();
    let after: string | null = null;
    let firstCursor: string | null = null;
    do {
      const page = await request(app)
        .get('/api/search/events')
        .query({ limit: 1, ...(after === null ? {} : { after }) });
      expect(page.status).toBe(200);
      const body = page.body as {
        data: { event: { id: string } }[];
        pagination: { total: number; nextCursor: string | null };
      };
      expect(body.pagination.total).toBe(4);
      expect(body.data).toHaveLength(1);
      const [item] = body.data;
      if (item === undefined) throw new Error('Search page returned no item');
      expect(seenIds.has(item.event.id)).toBe(false);
      seenIds.add(item.event.id);
      after = body.pagination.nextCursor;
      firstCursor ??= after;
    } while (after !== null);
    expect(seenIds.size).toBe(4);

    const mismatch = await request(app)
      .get('/api/search/events')
      .query({ limit: 1, after: firstCursor, city: 'Moscow' });
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { error: { code: string } }).error.code).toBe(
      'SEARCH_CURSOR_MISMATCH',
    );
  });

  it('upserts an edited eligible event and deletes it when it becomes ineligible', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    const eventId = await createSearchEvent(postgres.pool, communityId, {
      title: 'Original title',
    });
    await index.rebuild(source);
    const projector = new BestEffortEventSearchProjector(source, index, logger);

    await postgres.pool.query(
      `UPDATE events SET title = 'Updated title', updated_at = now() WHERE id = $1`,
      [eventId],
    );
    projector.schedule(eventId);
    await projector.drain();
    await elasticsearch.client.indices.refresh({ index: EVENT_SEARCH_READ_ALIAS });
    const updated = await elasticsearch.client.get({
      index: EVENT_SEARCH_READ_ALIAS,
      id: eventId,
    });
    expect((updated._source as { title: string }).title).toBe('Updated title');

    await postgres.pool.query(`UPDATE events SET visibility = 'COMMUNITY_ONLY' WHERE id = $1`, [
      eventId,
    ]);
    projector.schedule(eventId);
    await projector.drain();
    expect(await elasticsearch.client.exists({ index: EVENT_SEARCH_READ_ALIAS, id: eventId })).toBe(
      false,
    );
  });

  it('validates the HTTP boundary before calling Elasticsearch', async () => {
    const invalidSuggestion = await request(app)
      .get('/api/search/events/suggestions')
      .query({ q: 'w' });
    expect(invalidSuggestion.status).toBe(400);
    expect((invalidSuggestion.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR',
    );

    const invalidRange = await request(app).get('/api/search/events').query({
      startsAfter: '2030-08-04T00:00:00.000Z',
      startsBefore: '2030-08-03T00:00:00.000Z',
    });
    expect(invalidRange.status).toBe(400);
  });
});
