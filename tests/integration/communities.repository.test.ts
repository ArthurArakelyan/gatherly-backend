import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { aliceId } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('CommunitiesRepository with PostgreSQL', () => {
  let harness: PostgresHarness;
  let repository: CommunitiesRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new CommunitiesRepository(harness.pool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('creates a community and owner membership in the same transaction', async () => {
    const community = await repository.createWithOwner(aliceId, {
      name: 'Chess Club',
      slug: 'chess-club',
      description: '',
      city: null,
      country: null,
    });

    const membership = await harness.pool.query<{ role: string; status: string }>(
      `SELECT role, status FROM community_memberships
       WHERE community_id = $1 AND user_id = $2`,
      [community.id, aliceId],
    );
    expect(membership.rows[0]).toEqual({ role: 'OWNER', status: 'ACTIVE' });
  });
});
