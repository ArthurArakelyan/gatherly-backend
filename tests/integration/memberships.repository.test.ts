import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MembershipsRepository } from '../../src/modules/memberships/memberships.repository.js';
import { bobId, createCommunityFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('MembershipsRepository with PostgreSQL', () => {
  let harness: PostgresHarness;
  let repository: MembershipsRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new MembershipsRepository(harness.pool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates an active membership and transitions it to LEFT', async () => {
    const communityId = await createCommunityFixture(harness.pool);

    await expect(repository.joinOpenCommunity(communityId, bobId)).resolves.toBe('CREATED');
    await expect(repository.leaveCommunity(communityId, bobId)).resolves.toBe('LEFT');

    const status = await harness.pool.query<{ status: string }>(
      `SELECT status FROM community_memberships WHERE community_id = $1 AND user_id = $2`,
      [communityId, bobId],
    );
    expect(status.rows[0]?.status).toBe('LEFT');
  });
});
