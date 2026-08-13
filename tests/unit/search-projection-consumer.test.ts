import type { KafkaMessage } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import type { ProcessedEventsRepository } from '../../src/infrastructure/kafka/processed-events.repository.js';
import type { EventSearchProjector } from '../../src/modules/search/event-search-projector.js';
import {
  PoisonKafkaRecordError,
  SearchProjectionConsumer,
} from '../../src/modules/search/search-projection-consumer.js';
import { createEventChangedEnvelope } from '../../src/shared/events/domain-event.js';

const eventId = '00000000-0000-4000-8000-000000000001';

const kafkaMessage = (value: unknown, key = eventId): KafkaMessage => ({
  key: Buffer.from(key),
  value: Buffer.from(JSON.stringify(value)),
  timestamp: '1912010400000',
  attributes: 0,
  offset: '7',
  headers: {},
});

const createDependencies = (processed = false, outcome: 'indexed' | 'deleted' = 'indexed') => {
  const hasProcessed = vi.fn().mockResolvedValue(processed);
  const markProcessed = vi.fn().mockResolvedValue(undefined);
  const sync = vi.fn().mockResolvedValue(outcome);
  const processedEvents = { hasProcessed, markProcessed } as unknown as ProcessedEventsRepository;
  const projector = { sync } as unknown as EventSearchProjector;

  return { hasProcessed, markProcessed, sync, processedEvents, projector };
};

describe('SearchProjectionConsumer', () => {
  it('projects a valid event before recording it as processed', async () => {
    const envelope = createEventChangedEnvelope(eventId);
    const dependencies = createDependencies();
    const consumer = new SearchProjectionConsumer(
      'search-v1',
      dependencies.processedEvents,
      dependencies.projector,
    );
    const record = {
      topic: 'gatherly.domain-events.v1',
      partition: 2,
      offset: '7',
      message: kafkaMessage(envelope),
    };

    await expect(consumer.handle(record)).resolves.toBe('indexed');

    expect(dependencies.sync).toHaveBeenCalledWith(eventId);
    expect(dependencies.markProcessed).toHaveBeenCalledWith('search-v1', envelope.id, record);
    expect(dependencies.sync.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.markProcessed.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('skips an envelope already recorded by this logical consumer', async () => {
    const dependencies = createDependencies(true);
    const consumer = new SearchProjectionConsumer(
      'search-v1',
      dependencies.processedEvents,
      dependencies.projector,
    );

    await expect(
      consumer.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message: kafkaMessage(createEventChangedEnvelope(eventId)),
      }),
    ).resolves.toBe('duplicate');
    expect(dependencies.sync).not.toHaveBeenCalled();
    expect(dependencies.markProcessed).not.toHaveBeenCalled();
  });

  it('ignores unrelated valid envelopes without writing the ledger', async () => {
    const dependencies = createDependencies();
    const consumer = new SearchProjectionConsumer(
      'search-v1',
      dependencies.processedEvents,
      dependencies.projector,
    );

    await expect(
      consumer.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message: kafkaMessage({
          id: '00000000-0000-4000-8000-000000000010',
          type: 'gatherly.community.changed',
          version: 1,
        }),
      }),
    ).resolves.toBe('ignored');
    expect(dependencies.hasProcessed).not.toHaveBeenCalled();
  });

  it.each([
    ['null value', { ...kafkaMessage({}), value: null }],
    ['invalid JSON', { ...kafkaMessage({}), value: Buffer.from('{') }],
    [
      'unsupported known version',
      kafkaMessage({ ...createEventChangedEnvelope(eventId), version: 2 }),
    ],
    [
      'mismatched key',
      kafkaMessage(createEventChangedEnvelope(eventId), '00000000-0000-4000-8000-000000000002'),
    ],
  ])('classifies %s as poison', async (_name, message) => {
    const dependencies = createDependencies();
    const consumer = new SearchProjectionConsumer(
      'search-v1',
      dependencies.processedEvents,
      dependencies.projector,
    );

    await expect(
      consumer.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message,
      }),
    ).rejects.toBeInstanceOf(PoisonKafkaRecordError);
    expect(dependencies.markProcessed).not.toHaveBeenCalled();
  });

  it('does not mark the envelope when Elasticsearch projection fails', async () => {
    const dependencies = createDependencies();
    dependencies.sync.mockRejectedValueOnce(new Error('Elasticsearch unavailable'));
    const consumer = new SearchProjectionConsumer(
      'search-v1',
      dependencies.processedEvents,
      dependencies.projector,
    );

    await expect(
      consumer.handle({
        topic: 'gatherly.domain-events.v1',
        partition: 0,
        offset: '1',
        message: kafkaMessage(createEventChangedEnvelope(eventId)),
      }),
    ).rejects.toThrow('Elasticsearch unavailable');
    expect(dependencies.markProcessed).not.toHaveBeenCalled();
  });
});
