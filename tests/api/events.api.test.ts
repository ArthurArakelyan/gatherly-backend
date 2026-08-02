import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId, bobId, createCommunityFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { createTestApp } from '../helpers/test-app.js';

describe('events API', () => {
  let harness: PostgresHarness;
  let app: Express;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    app = createTestApp(harness.pool);
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
      .set('x-user-id', bobId)
      .send(eventBody);
    expect(forbidden.status).toBe(403);

    const created = await request(app)
      .post(`/api/communities/${communityId}/events`)
      .set('x-user-id', aliceId)
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
});
