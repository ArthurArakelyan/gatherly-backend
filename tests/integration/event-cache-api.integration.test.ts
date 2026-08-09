import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RedisCache } from '../../src/infrastructure/redis/cache.js';
import { createEventCache } from '../../src/modules/events/events.cache.js';
import { createCommunityFixture, createEventFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';
import { createTestApp } from '../helpers/test-app.js';

describe('event cache API integration', () => {
  let postgres: PostgresHarness;
  let redis: RedisHarness;
  let app: Express;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgresHarness(), startRedisHarness()]);
    const eventCache = createEventCache(new RedisCache(redis.client, pino({ enabled: false })), 60);
    app = createTestApp(postgres, { eventCache });
  }, 60_000);

  beforeEach(async () => {
    await Promise.all([postgres.reset(), redis.reset()]);
    await postgres.seed();
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it('serves a cached event and reconstructs it from PostgreSQL after deletion', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const key = `gatherly:v1:event:${eventId}`;

    const first = await request(app).get(`/api/events/${eventId}`);
    expect(first.status).toBe(200);
    expect(await redis.client.exists(key)).toBe(1);
    expect(await redis.client.ttl(key)).toBeGreaterThan(0);

    await postgres.pool.query(
      `UPDATE events
       SET title = $2, updated_at = now()
       WHERE id = $1`,
      [eventId, 'Updated only in PostgreSQL'],
    );

    const cached = await request(app).get(`/api/events/${eventId}`);
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual(first.body);

    await redis.client.del(key);

    const reloaded = await request(app).get(`/api/events/${eventId}`);
    expect(reloaded.status).toBe(200);
    expect((reloaded.body as { data: { title: string } }).data.title).toBe(
      'Updated only in PostgreSQL',
    );
    expect(await redis.client.exists(key)).toBe(1);
  });
});
