import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EventsRepository } from '../../src/modules/events/events.repository.js';
import { aliceId, createCommunityFixture } from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('EventsRepository with PostgreSQL', () => {
  let harness: PostgresHarness;
  let repository: EventsRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new EventsRepository(harness.pool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('stores an event and returns it through public filters', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const created = await repository.create(communityId, aliceId, {
      title: 'Board games',
      slug: 'board-games',
      description: '',
      format: 'IN_PERSON',
      visibility: 'PUBLIC',
      startsAt: new Date('2030-08-03T18:00:00.000Z'),
      endsAt: new Date('2030-08-03T21:00:00.000Z'),
      timezone: 'Europe/Moscow',
      capacity: 10,
    });

    const page = await repository.listPublic({
      communityId,
      status: 'PUBLISHED',
      startsAfter: null,
      startsBefore: null,
      page: 1,
      limit: 10,
    });
    expect(page.items.map((event) => event.id)).toEqual([created.id]);
  });
});
