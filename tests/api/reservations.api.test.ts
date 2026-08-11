import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addActiveMember,
  aliceId,
  bobId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
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

  it('rejects a reservation after membership becomes suspended', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventId = await createEventFixture(harness.pool, communityId);

    await harness.pool.query(
      `UPDATE community_memberships
       SET status = 'SUSPENDED', updated_at = now()
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, aliceId],
    );

    const response = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .set('Idempotency-Key', 'suspended-membership-attempt')
      .send({});

    expect(response.status).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      'COMMUNITY_PERMISSION_DENIED',
    );

    const state = await harness.pool.query<{ reservations: number; waitlist: number }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND user_id = $2) AS reservations,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND user_id = $2) AS waitlist`,
      [eventId, aliceId],
    );
    expect(state.rows[0]).toEqual({ reservations: 0, waitlist: 0 });
  });

  it('reads and cancels the confirmed reservation created by the same authenticated user', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventId = await createEventFixture(harness.pool, communityId);
    const authorization = authorizationFor(aliceId);

    const created = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorization)
      .set('Idempotency-Key', 'confirmed-read-delete')
      .send({});

    expect(created.status).toBe(201);
    expect((created.body as { data: { attendanceStatus: string } }).data.attendanceStatus).toBe(
      'CONFIRMED',
    );

    const found = await request(app)
      .get(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorization);
    expect(found.status).toBe(200);
    expect((found.body as { data: { status: string } }).data.status).toBe('CONFIRMED');

    const cancelled = await request(app)
      .delete(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorization);
    expect(cancelled.status).toBe(204);

    const missing = await request(app)
      .get(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorization);
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('RESERVATION_NOT_FOUND');
  });

  it('uses the waitlist resource when a full event returns WAITLISTED', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId, aliceId, 1);
    await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorizationFor(aliceId))
      .set('Idempotency-Key', 'fill-event')
      .send({});

    const authorization = authorizationFor(bobId);
    const created = await request(app)
      .post(`/api/events/${eventId}/reservations`)
      .set('authorization', authorization)
      .set('Idempotency-Key', 'bob-waitlisted')
      .send({});
    expect(created.status).toBe(201);
    expect((created.body as { data: { attendanceStatus: string } }).data.attendanceStatus).toBe(
      'WAITLISTED',
    );

    const noReservation = await request(app)
      .get(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorization);
    expect(noReservation.status).toBe(404);

    const waitlist = await request(app)
      .get(`/api/events/${eventId}/waitlist/me`)
      .set('authorization', authorization);
    expect(waitlist.status).toBe(200);
    expect((waitlist.body as { data: { status: string; position: number } }).data).toMatchObject({
      status: 'WAITING',
      position: 1,
    });

    const cancelled = await request(app)
      .delete(`/api/events/${eventId}/waitlist/me`)
      .set('authorization', authorization);
    expect(cancelled.status).toBe(204);
  });
});
