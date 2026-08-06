import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId, createCommunityFixture, createEventFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

describe('reservations API', () => {
  let harness: PostgresHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    app = createTestApp(harness);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('requires an idempotency key, replays it, and rejects a new duplicate intent', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventId = await createEventFixture(harness.pool, communityId);

    const missingKey = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .send({});
    expect(missingKey.status).toBe(400);
    expect((missingKey.body as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );

    const first = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .set('Idempotency-Key', 'alice-reserve')
      .send({});
    expect(first.status).toBe(201);
    expect((first.body as { data: { attendanceStatus: string } }).data.attendanceStatus).toBe(
      'CONFIRMED',
    );

    const replay = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .set('Idempotency-Key', 'alice-reserve')
      .send({});
    expect(replay.body).toEqual(first.body);

    const duplicate = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .set('Idempotency-Key', 'alice-new-intent')
      .send({});
    expect(duplicate.status).toBe(409);
    expect((duplicate.body as { error: { code: string } }).error.code).toBe('ALREADY_RESERVED');
  });
});
