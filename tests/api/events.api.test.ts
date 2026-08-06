import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId, bobId, createCommunityFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { authorizationFor, createTestApp } from '../helpers/test-app.js';

describe('events API', () => {
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

  it('enforces event creation authorization and exposes public event reads', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventBody = {
      title: 'Board games',
      slug: 'board-games',
      startsAt: '2030-08-03T18:00:00.000Z',
      endsAt: '2030-08-03T21:00:00.000Z',
      timezone: 'Europe/Moscow',
      capacity: 10,
    };

    const forbidden = await request(app)
      .post(`/api/communities/${communityId}/events`)
      .set('authorization', authorizationFor(bobId))
      .send(eventBody);
    expect(forbidden.status).toBe(403);

    const created = await request(app)
      .post(`/api/communities/${communityId}/events`)
      .set('authorization', authorizationFor(aliceId))
      .send(eventBody);
    expect(created.status).toBe(201);
    const eventId = (created.body as { data: { id: string } }).data.id;

    const listed = await request(app).get(`/api/events?communityId=${communityId}&limit=10`);
    expect(listed.status).toBe(200);
    expect((listed.body as { data: unknown[] }).data).toHaveLength(1);

    const fetched = await request(app).get(`/api/events/${eventId}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { data: { title: string } }).data.title).toBe('Board games');
  });

  it('does not carry organizer authority from one community into another', async () => {
    const firstCommunityId = await createCommunityFixture(harness.pool);
    const secondCommunityId = await createCommunityFixture(harness.pool);

    await harness.pool.query(
      `INSERT INTO community_memberships (community_id, user_id, role, status)
       VALUES ($1, $2, 'ORGANIZER', 'ACTIVE')`,
      [firstCommunityId, bobId],
    );

    const eventBody = {
      title: 'Cross-community attempt',
      slug: 'cross-community-attempt',
      startsAt: '2030-08-03T18:00:00.000Z',
      endsAt: '2030-08-03T21:00:00.000Z',
      timezone: 'Europe/Moscow',
      capacity: 10,
    };

    const allowed = await request(app)
      .post(`/api/communities/${firstCommunityId}/events`)
      .set('authorization', authorizationFor(bobId))
      .send(eventBody);
    expect(allowed.status).toBe(201);

    const denied = await request(app)
      .post(`/api/communities/${secondCommunityId}/events`)
      .set('authorization', authorizationFor(bobId))
      .send({ ...eventBody, slug: 'cross-community-denied' });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe(
      'COMMUNITY_PERMISSION_DENIED',
    );
  });
});
