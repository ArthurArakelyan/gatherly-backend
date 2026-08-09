import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/infrastructure/redis/cache.js';
import { RedisFixedWindowRateLimiter } from '../../src/infrastructure/redis/redis-fixed-window-rate-limiter.js';
import { createEventCache } from '../../src/modules/events/events.cache.js';
import type { Event } from '../../src/modules/events/events.types.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';

const event: Event = {
  id: '10000000-0000-4000-8000-000000000001',
  communityId: '20000000-0000-4000-8000-000000000001',
  createdByUserId: '30000000-0000-4000-8000-000000000001',
  title: 'Cached board games',
  slug: 'cached-board-games',
  description: 'A disposable cache value',
  format: 'IN_PERSON',
  status: 'PUBLISHED',
  visibility: 'PUBLIC',
  startsAt: new Date('2030-08-03T18:00:00.000Z'),
  endsAt: new Date('2030-08-03T21:00:00.000Z'),
  timezone: 'Europe/Moscow',
  capacity: 10,
  createdAt: new Date('2026-08-07T00:00:00.000Z'),
  updatedAt: new Date('2026-08-07T00:00:00.000Z'),
};

const logger = pino({ enabled: false });

describe('Redis infrastructure', () => {
  let harness: RedisHarness;

  beforeAll(async () => {
    harness = await startRedisHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('round-trips an event with real dates and a bounded TTL', async () => {
    const cache = createEventCache(new RedisCache(harness.client, logger), 60);

    await cache.set(event);
    await expect(cache.get(event.id)).resolves.toEqual(event);

    const ttl = await harness.client.ttl(`gatherly:v1:event:${event.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it.each([
    ['malformed JSON', '{'],
    ['a structurally invalid event', '{"id":"not-a-valid-cached-event"}'],
  ])('deletes %s and treats it as a cache miss', async (_description, cachedValue) => {
    const key = `gatherly:v1:event:${event.id}`;
    const cache = createEventCache(new RedisCache(harness.client, logger), 60);
    await harness.client.set(key, cachedValue, { EX: 60 });

    await expect(cache.get(event.id)).resolves.toBeNull();
    await expect(harness.client.exists(key)).resolves.toBe(0);
  });

  it('increments one shared fixed window atomically and preserves its TTL', async () => {
    const limiter = new RedisFixedWindowRateLimiter(harness.client, logger);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => limiter.consume('sign-in', '127.0.0.1', 10, 900)),
    );

    expect(results.filter((result) => result?.allowed === true)).toHaveLength(10);
    expect(results.filter((result) => result?.allowed === false)).toHaveLength(2);

    const [key] = await harness.client.keys('gatherly:v1:rate:sign-in:*');
    if (key === undefined) throw new Error('Redis limiter did not create its counter key');

    const ttl = await harness.client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('degrades cleanly when noeviction rejects new writes', async () => {
    const memory = await harness.client.info('memory');
    const usedMemory = /^used_memory:(\d+)$/m.exec(memory)?.[1];
    if (usedMemory === undefined) throw new Error('Redis INFO did not report used_memory');

    await harness.client.configSet('maxmemory', String(Math.max(1, Number(usedMemory) - 1)));
    await harness.client.configSet('maxmemory-policy', 'noeviction');

    const cache = createEventCache(new RedisCache(harness.client, logger), 60);
    await expect(cache.set(event)).resolves.toBeUndefined();
    await expect(harness.client.exists(`gatherly:v1:event:${event.id}`)).resolves.toBe(0);

    const limiter = new RedisFixedWindowRateLimiter(harness.client, logger);
    await expect(limiter.consume('sign-in', '127.0.0.1', 10, 900)).resolves.toBeNull();
  });
});
