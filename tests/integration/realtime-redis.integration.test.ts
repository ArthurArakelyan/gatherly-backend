import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedisClient } from '../../src/infrastructure/redis/client.js';
import {
  createRealtimeSubscriber,
  RedisRealtimeBus,
} from '../../src/infrastructure/redis/realtime-bus.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';

const logger = pino({ enabled: false });
const realtimeChannel = 'gatherly:realtime:wakeup:v1';

describe('realtime Redis wake-up bus', () => {
  let harness: RedisHarness;
  const closeCallbacks: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    harness = await startRedisHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('wakes local and remote application instances with a content-free hint', async () => {
    const targetA = { wakeAll: vi.fn() };
    const targetB = { wakeAll: vi.fn() };
    const subscriberA = createRealtimeSubscriber(harness.client, logger);
    const subscriberB = createRealtimeSubscriber(harness.client, logger);
    const observer = harness.client.duplicate();
    observer.on('error', () => {
      return undefined;
    });
    const busA = new RedisRealtimeBus(harness.client, subscriberA, targetA, logger);
    const busB = new RedisRealtimeBus(harness.client, subscriberB, targetB, logger);
    closeCallbacks.push(
      () => busA.close(),
      () => busB.close(),
      () => observer.close(),
    );

    busA.start();
    busB.start();
    await observer.connect();
    const messages: string[] = [];
    await observer.subscribe(realtimeChannel, (message) => {
      messages.push(message);
    });
    await vi.waitFor(() => {
      expect(subscriberA.isReady).toBe(true);
      expect(subscriberB.isReady).toBe(true);
    });

    busA.wake();

    expect(targetA.wakeAll).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(targetB.wakeAll).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(messages).toEqual(['wake']);
    });
  });

  it('still performs the local wake-up while its publisher is disconnected', () => {
    const disconnectedPublisher = createRedisClient(
      {
        REDIS_URL: 'redis://127.0.0.1:1',
        REDIS_CONNECT_TIMEOUT_MS: 100,
      },
      logger,
    );
    const subscriber = createRealtimeSubscriber(disconnectedPublisher, logger);
    const target = { wakeAll: vi.fn() };
    const bus = new RedisRealtimeBus(disconnectedPublisher, subscriber, target, logger);
    closeCallbacks.push(() => bus.close());

    bus.wake();

    expect(target.wakeAll).toHaveBeenCalledOnce();
    expect(disconnectedPublisher.isReady).toBe(false);
  });
});
