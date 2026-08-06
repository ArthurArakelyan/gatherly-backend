import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId, bobId } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

interface AttendanceResponse {
  data: { attendanceStatus: 'CONFIRMED' | 'WAITLISTED' };
}

describe('reservation lifecycle', () => {
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

  it('creates a community, joins, reserves the final place, waitlists, cancels, and promotes', async () => {
    const live = await request(app).get('/health/live');
    const ready = await request(app).get('/health/ready');
    expect(live.body).toEqual({ status: 'ok' });
    expect(ready.body).toEqual({ status: 'ready' });

    const community = await request(app)
      .post('/api/communities')
      .set('authorization', authorizationFor(aliceId))
      .send({ name: 'Lifecycle Club', slug: 'lifecycle-club' });
    expect(community.status).toBe(201);
    const communityId = (community.body as { data: { id: string } }).data.id;

    const listedCommunities = await request(app).get('/api/communities?limit=10');
    const fetchedCommunity = await request(app).get(`/api/communities/${communityId}`);
    expect((listedCommunities.body as { data: unknown[] }).data).toHaveLength(1);
    expect((fetchedCommunity.body as { data: { id: string } }).data.id).toBe(communityId);

    const joined = await request(app)
      .post(`/api/communities/${communityId}/join`)
      .set('authorization', authorizationFor(bobId));
    expect(joined.status).toBe(201);

    const event = await request(app)
      .post(`/api/communities/${communityId}/events`)
      .set('authorization', authorizationFor(aliceId))
      .send({
        title: 'One Chair Workshop',
        slug: 'one-chair-workshop',
        startsAt: '2030-08-03T18:00:00.000Z',
        endsAt: '2030-08-03T21:00:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 1,
      });
    expect(event.status).toBe(201);
    const eventId = (event.body as { data: { id: string } }).data.id;

    const listedEvents = await request(app).get(`/api/events?communityId=${communityId}&limit=10`);
    const fetchedEvent = await request(app).get(`/api/events/${eventId}`);
    expect((listedEvents.body as { data: unknown[] }).data).toHaveLength(1);
    expect((fetchedEvent.body as { data: { id: string } }).data.id).toBe(eventId);

    const requests = await Promise.all([
      request(app)
        .post(`/api/events/${eventId}/reservations`)
        .set('authorization', authorizationFor(aliceId))
        .set('Idempotency-Key', 'lifecycle-alice')
        .send({}),
      request(app)
        .post(`/api/events/${eventId}/reservations`)
        .set('authorization', authorizationFor(bobId))
        .set('Idempotency-Key', 'lifecycle-bob')
        .send({}),
    ]);
    expect(requests.map((response) => response.status)).toEqual([201, 201]);

    const outcomes = [
      { userId: aliceId, body: requests[0].body as AttendanceResponse },
      { userId: bobId, body: requests[1].body as AttendanceResponse },
    ];
    const confirmedUser = outcomes.find(
      ({ body }) => body.data.attendanceStatus === 'CONFIRMED',
    )?.userId;
    const waitlistedUser = outcomes.find(
      ({ body }) => body.data.attendanceStatus === 'WAITLISTED',
    )?.userId;
    if (confirmedUser === undefined || waitlistedUser === undefined) {
      throw new Error('Expected one confirmed and one waitlisted user');
    }

    const waitlistEntry = await request(app)
      .get(`/api/events/${eventId}/waitlist/me`)
      .set('authorization', authorizationFor(waitlistedUser));
    expect(waitlistEntry.status).toBe(200);
    expect((waitlistEntry.body as { data: { status: string } }).data.status).toBe('WAITING');

    const cancelled = await request(app)
      .delete(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorizationFor(confirmedUser));
    expect(cancelled.status).toBe(204);

    const promoted = await request(app)
      .get(`/api/events/${eventId}/reservations/me`)
      .set('authorization', authorizationFor(waitlistedUser));
    expect(promoted.status).toBe(200);
    expect((promoted.body as { data: { status: string } }).data.status).toBe('CONFIRMED');

    const databaseState = await harness.pool.query<{
      confirmed: number;
      promoted: number;
      notifications: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND status = 'PROMOTED') AS promoted,
         (SELECT count(*)::integer FROM notifications
          WHERE user_id = $2 AND type = 'WAITLIST_PROMOTED' AND data->>'eventId' = $1::text)
          AS notifications`,
      [eventId, waitlistedUser],
    );
    expect(databaseState.rows[0]).toEqual({ confirmed: 1, promoted: 1, notifications: 1 });
  });
});
