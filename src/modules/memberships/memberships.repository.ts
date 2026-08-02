import type { Pool } from 'pg';

import { withTransaction } from '../../shared/database/transaction.js';
import type { JoinPersistenceOutcome, LeavePersistenceOutcome } from './memberships.types.js';

interface CommunityRow {
  join_policy: string;
}

interface MembershipRow {
  role: string;
  status: string;
}

export class MembershipsRepository {
  public constructor(private readonly pool: Pool) {}

  public joinOpenCommunity(communityId: string, userId: string): Promise<JoinPersistenceOutcome> {
    return withTransaction(this.pool, async (client) => {
      const community = await client.query<CommunityRow>(
        `SELECT join_policy
         FROM communities
         WHERE id = $1 AND status = 'ACTIVE'
         FOR UPDATE`,
        [communityId],
      );
      const communityRow = community.rows[0];
      if (communityRow === undefined) return 'COMMUNITY_NOT_FOUND';
      if (communityRow.join_policy !== 'OPEN') return 'JOIN_NOT_AVAILABLE';

      const existing = await client.query<MembershipRow>(
        `SELECT role, status
         FROM community_memberships
         WHERE community_id = $1 AND user_id = $2
         FOR UPDATE`,
        [communityId, userId],
      );
      const membership = existing.rows[0];

      if (membership?.status === 'BANNED' || membership?.status === 'SUSPENDED') {
        return 'BLOCKED';
      }
      if (membership?.status === 'ACTIVE') return 'ALREADY_ACTIVE';

      if (membership === undefined) {
        await client.query(
          `INSERT INTO community_memberships (community_id, user_id, role, status)
           VALUES ($1, $2, 'MEMBER', 'ACTIVE')`,
          [communityId, userId],
        );
        return 'CREATED';
      }

      await client.query(
        `UPDATE community_memberships
         SET role = 'MEMBER', status = 'ACTIVE', joined_at = now(), updated_at = now()
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      return 'REACTIVATED';
    });
  }

  public leaveCommunity(communityId: string, userId: string): Promise<LeavePersistenceOutcome> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<MembershipRow>(
        `SELECT role, status
         FROM community_memberships
         WHERE community_id = $1 AND user_id = $2
         FOR UPDATE`,
        [communityId, userId],
      );
      const membership = existing.rows[0];

      if (membership?.status !== 'ACTIVE') return 'NOT_ACTIVE';
      if (membership.role === 'OWNER') return 'OWNER';

      await client.query(
        `UPDATE community_memberships
         SET status = 'LEFT', updated_at = now()
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      return 'LEFT';
    });
  }
}
