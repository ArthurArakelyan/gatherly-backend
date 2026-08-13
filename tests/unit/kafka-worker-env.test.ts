import { describe, expect, it } from 'vitest';

import {
  parseOutboxPublisherEnvironment,
  parseSearchConsumerEnvironment,
} from '../../src/config/kafka-worker-env.js';

const publisherEnvironment = {
  DATABASE_URL: 'postgresql://gatherly:gatherly@localhost:5432/gatherly',
  PRISMA_POOL_MAX: '5',
  KAFKA_BROKERS: 'localhost:9092, localhost:9093',
  KAFKA_CLIENT_ID: 'gatherly-test',
  KAFKA_DOMAIN_EVENTS_TOPIC: 'gatherly.domain-events.v1',
  KAFKA_REQUEST_TIMEOUT_MS: '5000',
  KAFKA_OUTBOX_POLL_INTERVAL_MS: '500',
  KAFKA_OUTBOX_BATCH_SIZE: '25',
};

describe('Kafka worker environment', () => {
  it('parses and trims a comma-separated broker list', () => {
    const parsed = parseOutboxPublisherEnvironment(publisherEnvironment);

    expect(parsed.KAFKA_BROKERS).toEqual(['localhost:9092', 'localhost:9093']);
    expect(parsed.KAFKA_OUTBOX_BATCH_SIZE).toBe(25);
  });

  it('rejects blank brokers, invalid bounds, and topic-name drift', () => {
    expect(() =>
      parseOutboxPublisherEnvironment({ ...publisherEnvironment, KAFKA_BROKERS: ' , ' }),
    ).toThrow();
    expect(() =>
      parseOutboxPublisherEnvironment({ ...publisherEnvironment, KAFKA_OUTBOX_BATCH_SIZE: '0' }),
    ).toThrow();
    expect(() =>
      parseOutboxPublisherEnvironment({
        ...publisherEnvironment,
        KAFKA_DOMAIN_EVENTS_TOPIC: 'typo.domain-events.v1',
      }),
    ).toThrow();
  });

  it('requires Elasticsearch only for the search consumer role', () => {
    expect(() => parseSearchConsumerEnvironment(publisherEnvironment)).toThrow();

    const parsed = parseSearchConsumerEnvironment({
      ...publisherEnvironment,
      KAFKA_SEARCH_GROUP_ID: 'gatherly-search-projection-v1',
      KAFKA_DEAD_LETTER_TOPIC: 'gatherly.domain-events.dlq.v1',
      ELASTICSEARCH_URL: 'http://localhost:9200',
      ELASTICSEARCH_REQUEST_TIMEOUT_MS: '2000',
      ELASTICSEARCH_INDEX_PREFIX: 'gatherly-events',
    });

    expect(parsed.KAFKA_SEARCH_GROUP_ID).toBe('gatherly-search-projection-v1');
  });
});
