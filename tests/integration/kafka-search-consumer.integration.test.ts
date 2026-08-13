import { randomUUID } from 'node:crypto';

import type { KafkaMessage } from 'kafkajs';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EVENT_SEARCH_READ_ALIAS } from '../../src/infrastructure/elasticsearch/event-index-definition.js';
import { EventSearchIndex } from '../../src/infrastructure/elasticsearch/event-search-index.js';
import { ProcessedEventsRepository } from '../../src/infrastructure/kafka/processed-events.repository.js';
import { EventSearchProjector } from '../../src/modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../../src/modules/search/event-search-source.repository.js';
import { SearchProjectionConsumer } from '../../src/modules/search/search-projection-consumer.js';
import { createEventChangedEnvelope } from '../../src/shared/events/domain-event.js';
import { createCommunityFixture, createEventFixture } from '../fixtures/database.js';
import { type ElasticsearchHarness, startElasticsearchHarness } from '../helpers/elasticsearch.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

const kafkaMessage = (key: string, value: unknown, offset: string): KafkaMessage => ({
  key: Buffer.from(key),
  value: Buffer.from(JSON.stringify(value)),
  timestamp: String(Date.now()),
  attributes: 0,
  offset,
  headers: {},
});

describe('Kafka search projection consumer', { concurrent: false }, () => {
  let postgres: PostgresHarness;
  let elasticsearch: ElasticsearchHarness;

  beforeAll(async () => {
    [postgres, elasticsearch] = await Promise.all([
      startPostgresHarness(),
      startElasticsearchHarness(),
    ]);
  }, 180_000);

  beforeEach(async () => {
    await postgres.reset();
    await postgres.seed();
    await elasticsearch.reset();
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), elasticsearch.stop()]);
  });

  it('skips a duplicate and applies a later ineligibility change', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const source = new EventSearchSourceRepository(postgres.prisma);
    const index = new EventSearchIndex(
      elasticsearch.client,
      elasticsearch.indexPrefix,
      pino({ enabled: false }),
    );
    await index.rebuild(source);

    const consumerName = `search-test-${randomUUID()}`;
    const handler = new SearchProjectionConsumer(
      consumerName,
      new ProcessedEventsRepository(postgres.prisma),
      new EventSearchProjector(source, index),
    );
    const created = createEventChangedEnvelope(eventId);
    const firstRecord = {
      topic: 'gatherly.domain-events.v1',
      partition: 0,
      offset: '0',
      message: kafkaMessage(eventId, created, '0'),
    };

    await expect(handler.handle(firstRecord)).resolves.toBe('indexed');
    await expect(handler.handle(firstRecord)).resolves.toBe('duplicate');
    await elasticsearch.client.indices.refresh({ index: EVENT_SEARCH_READ_ALIAS });

    const afterDuplicate = await elasticsearch.client.count({
      index: EVENT_SEARCH_READ_ALIAS,
      query: { ids: { values: [eventId] } },
    });
    expect(afterDuplicate.count).toBe(1);
    expect(
      await postgres.prisma.processedKafkaEvent.count({
        where: { consumerName, eventId: created.id },
      }),
    ).toBe(1);

    await postgres.prisma.event.update({
      where: { id: eventId },
      data: { status: 'CANCELLED', visibility: 'COMMUNITY_ONLY' },
    });
    const hidden = createEventChangedEnvelope(eventId);
    await expect(
      handler.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message: kafkaMessage(eventId, hidden, '1'),
      }),
    ).resolves.toBe('deleted');
    await elasticsearch.client.indices.refresh({ index: EVENT_SEARCH_READ_ALIAS });

    const afterDelete = await elasticsearch.client.count({
      index: EVENT_SEARCH_READ_ALIAS,
      query: { ids: { values: [eventId] } },
    });
    expect(afterDelete.count).toBe(0);
    expect(await postgres.prisma.processedKafkaEvent.count({ where: { consumerName } })).toBe(2);
  }, 30_000);
});
