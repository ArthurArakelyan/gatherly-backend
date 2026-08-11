import type { Pool } from 'pg';

import { realtimeEventSchema } from './realtime.schemas.js';
import type { RealtimeEvent, RealtimeEventReader } from './realtime.types.js';

interface RealtimeEventRow {
  id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export class RealtimeRepository implements RealtimeEventReader {
  public constructor(private readonly pool: Pool) {}

  public async isActiveUser(userId: string): Promise<boolean> {
    const result = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM users WHERE id = $1 AND status = 'ACTIVE'
       ) AS active`,
      [userId],
    );
    return result.rows[0]?.active ?? false;
  }

  public async findVisibleAfter(
    userId: string,
    afterId: bigint,
    limit: number,
  ): Promise<RealtimeEvent[]> {
    const result = await this.pool.query<RealtimeEventRow>(
      `SELECT realtime_event.id::text,
              realtime_event.type,
              realtime_event.payload,
              realtime_event.created_at
       FROM realtime_events AS realtime_event
       WHERE realtime_event.id > $2::bigint
         AND EXISTS (
           SELECT 1 FROM users AS connected_user
           WHERE connected_user.id = $1::uuid
             AND connected_user.status = 'ACTIVE'
         )
         AND (
           realtime_event.audience_user_id = $1::uuid
           OR EXISTS (
             SELECT 1
             FROM community_memberships AS membership
             JOIN communities AS community
               ON community.id = membership.community_id
             WHERE membership.user_id = $1::uuid
               AND membership.community_id = realtime_event.community_id
               AND membership.status = 'ACTIVE'
               AND membership.role IN ('OWNER', 'ORGANIZER', 'MODERATOR')
               AND community.status = 'ACTIVE'
           )
         )
       ORDER BY realtime_event.id ASC
       LIMIT $3`,
      [userId, afterId.toString(), limit],
    );

    return result.rows.map((row) =>
      realtimeEventSchema.parse({
        id: row.id,
        type: row.type,
        data: row.payload,
        createdAt: row.created_at,
      }),
    );
  }
}
