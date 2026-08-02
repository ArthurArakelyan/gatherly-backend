import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { aliceId, bobId, createCommunityFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { createTestApp } from '../helpers/test-app.js';

describe('memberships API', () => {
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

  it('joins an open community once, allows leaving, and prevents owner departure', async () => {
    const communityId = await createCommunityFixture(harness.pool);

    const joined = await request(app)
      .post(`/api/communities/${communityId}/join`)
      .set('x-user-id', bobId);
    expect(joined.status).toBe(201);
    expect(joined.body).toEqual({ data: { status: 'ACTIVE' } });

    const repeatedJoin = await request(app)
      .post(`/api/communities/${communityId}/join`)
      .set('x-user-id', bobId);
    expect(repeatedJoin.status).toBe(200);

    const left = await request(app)
      .post(`/api/communities/${communityId}/leave`)
      .set('x-user-id', bobId);
    expect(left.status).toBe(204);

    const ownerLeave = await request(app)
      .post(`/api/communities/${communityId}/leave`)
      .set('x-user-id', aliceId);
    expect(ownerLeave.status).toBe(409);
    expect((ownerLeave.body as { error: { code: string } }).error.code).toBe('OWNER_CANNOT_LEAVE');
  });
});
