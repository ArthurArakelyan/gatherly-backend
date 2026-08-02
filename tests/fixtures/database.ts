import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

export const aliceId = '00000000-0000-4000-8000-000000000001';
export const bobId = '00000000-0000-4000-8000-000000000002';
export const carolId = '00000000-0000-4000-8000-000000000003';

export const createCommunityFixture = async (pool: Pool, ownerId = aliceId): Promise<string> => {
  const suffix = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO communities (name, slug, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`Community ${suffix}`, `community-${suffix}`, ownerId],
  );
  const communityId = result.rows[0]?.id;
  if (communityId === undefined) throw new Error('Community fixture insert returned no row');

  await pool.query(
    `INSERT INTO community_memberships (community_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
    [communityId, ownerId],
  );
  return communityId;
};

export const addActiveMember = async (
  pool: Pool,
  communityId: string,
  userId: string,
): Promise<void> => {
  await pool.query(
    `INSERT INTO community_memberships (community_id, user_id, role, status)
     VALUES ($1, $2, 'MEMBER', 'ACTIVE')`,
    [communityId, userId],
  );
};

export const createEventFixture = async (
  pool: Pool,
  communityId: string,
  creatorId = aliceId,
  capacity = 1,
): Promise<string> => {
  const suffix = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO events
       (community_id, created_by_user_id, title, slug, starts_at, ends_at, timezone, capacity)
     VALUES
       ($1, $2, $3, $4, now() + interval '1 day', now() + interval '2 days', 'Europe/Moscow', $5)
     RETURNING id`,
    [communityId, creatorId, `Event ${suffix}`, `event-${suffix}`, capacity],
  );
  const eventId = result.rows[0]?.id;
  if (eventId === undefined) throw new Error('Event fixture insert returned no row');
  return eventId;
};
