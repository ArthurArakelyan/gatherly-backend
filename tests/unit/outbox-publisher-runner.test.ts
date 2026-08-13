import type { Producer, ProducerRecord } from 'kafkajs';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxRepository } from '../../src/infrastructure/kafka/outbox.repository.js';
import { OutboxPublisherRunner } from '../../src/workers/outbox-publisher-runner.js';

const record: ProducerRecord = {
  topic: 'gatherly.domain-events.v1',
  messages: [{ key: 'event-id', value: '{}' }],
};

describe('OutboxPublisherRunner', () => {
  it('publishes a bounded batch and stops promptly when aborted while idle', async () => {
    const abortController = new AbortController();
    const send = vi.fn().mockResolvedValue([]);
    let attempts = 0;
    const publishNext = vi.fn(async (publish: (value: ProducerRecord) => Promise<void>) => {
      attempts += 1;
      if (attempts === 1) {
        await publish(record);
        return true;
      }
      abortController.abort();
      return false;
    });
    const runner = new OutboxPublisherRunner(
      { publishNext } as unknown as OutboxRepository,
      { send } as unknown as Producer,
      pino({ enabled: false }),
      { batchSize: 5, idleDelayMs: 60_000, failureDelayMs: 60_000, requestTimeoutMs: 5_000 },
    );

    await expect(runner.run(abortController.signal)).resolves.toBeUndefined();

    expect(publishNext).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({ ...record, acks: -1, timeout: 5_000 });
  });

  it('logs a failed attempt without spinning after shutdown', async () => {
    const abortController = new AbortController();
    const logger = pino({ enabled: false });
    const logError = vi.spyOn(logger, 'error');
    const publishNext = vi.fn().mockImplementation(() => {
      abortController.abort();
      return Promise.reject(new Error('Kafka unavailable'));
    });
    const runner = new OutboxPublisherRunner(
      { publishNext } as unknown as OutboxRepository,
      { send: vi.fn() } as unknown as Producer,
      logger,
      { batchSize: 5, idleDelayMs: 60_000, failureDelayMs: 60_000, requestTimeoutMs: 5_000 },
    );

    await expect(runner.run(abortController.signal)).resolves.toBeUndefined();

    expect(publishNext).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledOnce();
  });
});
