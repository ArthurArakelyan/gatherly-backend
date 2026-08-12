import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRedisClient } from '../../src/infrastructure/redis/client.js';
import { WebSocketTicketStore } from '../../src/infrastructure/redis/websocket-ticket-store.js';
import { JwtAccessTokens } from '../../src/infrastructure/security/jwt-access-tokens.js';
import { ChatRepository } from '../../src/modules/chat/chat.repository.js';
import {
  addActiveMember,
  aliceId,
  bobId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

const logger = pino({ enabled: false });

describe('chat HTTP API', () => {
  let postgres: PostgresHarness;
  let redis: RedisHarness;
  let app: Express;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgresHarness(), startRedisHarness()]);
    app = createTestApp(postgres, {
      chatTicketStore: new WebSocketTicketStore(redis.client, logger, 30),
    });
  }, 60_000);

  beforeEach(async () => {
    await Promise.all([postgres.reset(), redis.reset()]);
    await postgres.seed();
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'Bearer bad'],
    [
      'forged',
      `Bearer ${new JwtAccessTokens({
        secret: 'another-test-secret-that-is-long-enough',
        issuer: 'gatherly-test-api',
        audience: 'gatherly-test-client',
        ttlSeconds: 900,
      }).sign(aliceId)}`,
    ],
    [
      'expired',
      `Bearer ${new JwtAccessTokens({
        secret: 'test-only-jwt-secret-that-is-long-enough',
        issuer: 'gatherly-test-api',
        audience: 'gatherly-test-client',
        ttlSeconds: -1,
      }).sign(aliceId)}`,
    ],
  ])('rejects an %s access token when issuing a ticket', async (_case, authorization) => {
    const response = await request(app)
      .post('/api/chat/websocket-tickets')
      .set(authorization === undefined ? {} : { authorization });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
  });

  it('rejects an inactive account and issues a short-lived opaque ticket to an active account', async () => {
    await postgres.pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [bobId]);
    const inactive = await request(app)
      .post('/api/chat/websocket-tickets')
      .set('authorization', authorizationFor(bobId));
    expect(inactive.status).toBe(401);

    const issued = await request(app)
      .post('/api/chat/websocket-tickets')
      .set('authorization', authorizationFor(aliceId));
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ data: { expiresIn: 30 } });
    expect((issued.body as { data: { ticket: string } }).data.ticket).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  it('returns a safe ticket error during Redis outage while REST history remains available', async () => {
    const unavailableRedis = createRedisClient(
      { REDIS_URL: 'redis://127.0.0.1:1', REDIS_CONNECT_TIMEOUT_MS: 50 },
      logger,
    );
    const outageApp = createTestApp(postgres, {
      chatTicketStore: new WebSocketTicketStore(unavailableRedis, logger, 30),
    });
    const communityId = await createCommunityFixture(postgres.pool);
    const eventId = await createEventFixture(postgres.pool, communityId);

    const ticket = await request(outageApp)
      .post('/api/chat/websocket-tickets')
      .set('authorization', authorizationFor(aliceId));
    expect(ticket.status).toBe(503);
    expect(ticket.body).toMatchObject({ error: { code: 'CHAT_HANDSHAKE_UNAVAILABLE' } });

    const history = await request(outageApp)
      .get(`/api/events/${eventId}/chat/messages`)
      .set('authorization', authorizationFor(aliceId));
    expect(history.status).toBe(200);
    expect(history.body).toEqual({ data: [], pagination: { nextCursor: null } });
  });

  it('validates history input, authorization, pagination, and tombstones', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    await addActiveMember(postgres.pool, communityId, bobId);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const repository = new ChatRepository(postgres.pool);
    const first = await repository.createMessage(eventId, bobId, randomUUID(), 'first');
    await repository.createMessage(eventId, bobId, randomUUID(), 'second');
    if (first === null) throw new Error('Expected message creation');
    await repository.deleteMessage(eventId, first.message.id, bobId);

    const unauthorized = await request(app)
      .get(`/api/events/${eventId}/chat/messages`)
      .set('authorization', authorizationFor('00000000-0000-4000-8000-000000000003'));
    expect(unauthorized.status).toBe(403);
    expect(unauthorized.body).toMatchObject({ error: { code: 'CHAT_ACCESS_DENIED' } });

    const invalid = await request(app)
      .get(`/api/events/${eventId}/chat/messages?limit=101`)
      .set('authorization', authorizationFor(aliceId));
    expect(invalid.status).toBe(400);

    const pageOne = await request(app)
      .get(`/api/events/${eventId}/chat/messages?limit=1`)
      .set('authorization', authorizationFor(aliceId));
    expect(pageOne.status).toBe(200);
    const cursor = (pageOne.body as { pagination: { nextCursor: string } }).pagination.nextCursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const pageTwo = await request(app)
      .get(`/api/events/${eventId}/chat/messages?limit=1&cursor=${cursor}`)
      .set('authorization', authorizationFor(aliceId));
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body).toMatchObject({
      data: [{ id: first.message.id, body: null }],
      pagination: { nextCursor: null },
    });

    const badCursor = await request(app)
      .get(`/api/events/${eventId}/chat/messages?cursor=YWJj`)
      .set('authorization', authorizationFor(aliceId));
    expect(badCursor.status).toBe(400);
    expect(badCursor.body).toMatchObject({ error: { code: 'INVALID_CHAT_CURSOR' } });
  });
});
