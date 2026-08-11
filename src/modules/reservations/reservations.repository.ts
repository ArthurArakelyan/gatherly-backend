import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../shared/database/transaction.js';
import type {
  ActiveAttendanceState,
  AttendanceOutcome,
  IdempotencyClaim,
  LockedEvent,
  ReservationCommandResult,
  ReservationSummary,
  WaitlistSummary,
} from './reservations.types.js';

interface LockedEventRow {
  id: string;
  community_id: string;
  status: string;
  starts_at: Date;
  capacity: number;
}

export class ReservationTransactionRepository {
  public constructor(private readonly client: PoolClient) {}

  public async lockEvent(eventId: string): Promise<LockedEvent | null> {
    const result = await this.client.query<LockedEventRow>(
      `SELECT id, community_id, status, starts_at, capacity
       FROM events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          communityId: row.community_id,
          status: row.status,
          startsAt: row.starts_at,
          capacity: row.capacity,
        };
  }

  public async findMembershipStatus(communityId: string, userId: string): Promise<string | null> {
    const result = await this.client.query<{ status: string }>(
      `SELECT status FROM community_memberships
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, userId],
    );
    return result.rows[0]?.status ?? null;
  }

  public async findActiveState(eventId: string, userId: string): Promise<ActiveAttendanceState> {
    const result = await this.client.query<ActiveAttendanceState>(
      `SELECT
         EXISTS (SELECT 1 FROM reservations
           WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED') AS reserved,
         EXISTS (SELECT 1 FROM waitlist_entries
           WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING') AS waiting`,
      [eventId, userId],
    );
    return result.rows[0] ?? { reserved: false, waiting: false };
  }

  public async countConfirmed(eventId: string): Promise<number> {
    const result = await this.client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM reservations
       WHERE event_id = $1 AND status = 'CONFIRMED'`,
      [eventId],
    );
    return result.rows[0]?.count ?? 0;
  }

  public async insertConfirmed(eventId: string, userId: string): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO reservations (event_id, user_id) VALUES ($1, $2) RETURNING id`,
      [eventId, userId],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('Reservation insert returned no row');
    return id;
  }

  public async insertWaiting(
    eventId: string,
    userId: string,
  ): Promise<{ id: string; joinedAt: Date }> {
    const result = await this.client.query<{ id: string; joined_at: Date }>(
      `INSERT INTO waitlist_entries (event_id, user_id)
       VALUES ($1, $2) RETURNING id, joined_at`,
      [eventId, userId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Waitlist insert returned no row');
    return { id: row.id, joinedAt: row.joined_at };
  }

  public async calculatePosition(
    eventId: string,
    joinedAt: Date,
    entryId: string,
  ): Promise<number> {
    const result = await this.client.query<{ position: number }>(
      `SELECT count(*)::integer AS position
       FROM waitlist_entries
       WHERE event_id = $1 AND status = 'WAITING'
         AND (joined_at, id) <= ($2::timestamptz, $3::uuid)`,
      [eventId, joinedAt, entryId],
    );
    return result.rows[0]?.position ?? 1;
  }

  public async cancelWaiting(eventId: string, userId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE waitlist_entries
       SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       WHERE event_id = $1 AND user_id = $2 AND status = 'WAITING'
         RETURNING id`,
      [eventId, userId],
    );
    return result.rowCount === 1;
  }

  public async insertNotification(
    userId: string,
    eventId: string,
    type: 'RESERVATION_CONFIRMED' | 'WAITLIST_JOINED',
  ): Promise<void> {
    const title = type === 'RESERVATION_CONFIRMED' ? 'Reservation confirmed' : 'Added to waitlist';
    const result = await this.client.query<{
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $3, jsonb_build_object('eventId', $4::text))
       RETURNING id, type, title, message, data, created_at`,
      [userId, type, title, eventId],
    );
    const notification = result.rows[0];
    if (notification === undefined) throw new Error('Notification insert returned no row');

    await this.insertNotificationRealtimeEvent(userId, notification);
  }

  private async insertNotificationRealtimeEvent(
    userId: string,
    notification: {
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO realtime_events (type, audience_user_id, payload)
       VALUES ('notification.created', $1, $2::jsonb)`,
      [
        userId,
        JSON.stringify({
          notification: {
            id: notification.id,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            data: notification.data,
            readAt: null,
            createdAt: notification.created_at.toISOString(),
          },
        }),
      ],
    );
  }

  public async insertAttendanceRealtimeEvent(communityId: string, eventId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO realtime_events (type, community_id, payload)
       SELECT 'event.attendance.updated', $1::uuid,
              jsonb_build_object(
                'eventId', event_record.id::text,
                'confirmedCount', (
                  SELECT count(*)::integer
                  FROM reservations
                  WHERE event_id = event_record.id AND status = 'CONFIRMED'
                ),
                'waitingCount', (
                  SELECT count(*)::integer
                  FROM waitlist_entries
                  WHERE event_id = event_record.id AND status = 'WAITING'
                ),
                'capacity', event_record.capacity
              )
       FROM events AS event_record
       WHERE event_record.id = $2::uuid`,
      [communityId, eventId],
    );
  }

  public async cancelConfirmed(eventId: string, userId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE reservations
     SET status = 'CANCELLED_BY_USER', cancelled_at = now(), updated_at = now()
     WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'
     RETURNING id`,
      [eventId, userId],
    );
    return result.rowCount === 1;
  }

  public async findFirstWaiting(eventId: string): Promise<{ id: string; userId: string } | null> {
    const result = await this.client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
     FROM waitlist_entries
     WHERE event_id = $1 AND status = 'WAITING'
     ORDER BY joined_at ASC, id ASC
     LIMIT 1 FOR UPDATE`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, userId: row.user_id };
  }

  public async promoteWaitlistEntry(entryId: string): Promise<void> {
    await this.client.query(
      `UPDATE waitlist_entries
     SET status = 'PROMOTED', promoted_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'WAITING'`,
      [entryId],
    );
  }

  public async insertPromotedReservation(eventId: string, userId: string): Promise<void> {
    await this.client.query(`INSERT INTO reservations (event_id, user_id) VALUES ($1, $2)`, [
      eventId,
      userId,
    ]);
  }

  public async insertPromotionNotification(userId: string, eventId: string): Promise<void> {
    const result = await this.client.query<{
      id: string;
      type: string;
      title: string;
      message: string;
      data: Record<string, unknown>;
      created_at: Date;
    }>(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, 'WAITLIST_PROMOTED', 'Reservation confirmed',
               'A place became available', jsonb_build_object('eventId', $2::text))
       RETURNING id, type, title, message, data, created_at`,
      [userId, eventId],
    );
    const notification = result.rows[0];
    if (notification === undefined) throw new Error('Notification insert returned no row');
    await this.insertNotificationRealtimeEvent(userId, notification);
  }

  public async claimIdempotency(
    userId: string,
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyClaim> {
    const inserted = await this.client.query<{ id: string }>(
      `INSERT INTO idempotency_keys (user_id, scope, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, scope, key) DO NOTHING
     RETURNING id`,
      [userId, scope, key, requestHash],
    );
    const id = inserted.rows[0]?.id;
    if (id !== undefined) return { kind: 'CLAIMED', id };

    const existing = await this.client.query<{
      request_hash: string;
      response_status: number | null;
      response_body: AttendanceOutcome | null;
    }>(
      `SELECT request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE user_id = $1 AND scope = $2 AND key = $3
     FOR UPDATE`,
      [userId, scope, key],
    );
    const record = existing.rows[0];
    if (record?.request_hash !== requestHash) return { kind: 'CONFLICT' };
    if (record.response_status === null || record.response_body === null) {
      return { kind: 'INCOMPLETE' };
    }
    return { kind: 'REPLAY', status: record.response_status, body: record.response_body };
  }

  public async completeIdempotency(id: string, result: ReservationCommandResult): Promise<void> {
    await this.client.query(
      `UPDATE idempotency_keys
     SET response_status = $2, response_body = $3::jsonb, completed_at = now()
     WHERE id = $1`,
      [id, result.status, JSON.stringify(result.body)],
    );
  }
}

export class ReservationsRepository {
  public constructor(private readonly pool: Pool) {}

  public inTransaction<T>(
    operation: (repository: ReservationTransactionRepository) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, (client) =>
      operation(new ReservationTransactionRepository(client)),
    );
  }

  public async findReservation(
    eventId: string,
    userId: string,
  ): Promise<ReservationSummary | null> {
    const result = await this.pool.query<{
      id: string;
      status: 'CONFIRMED';
      reserved_at: Date;
    }>(
      `SELECT id, status, reserved_at FROM reservations
       WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED'`,
      [eventId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, reservedAt: row.reserved_at };
  }

  public async findWaitlistEntry(eventId: string, userId: string): Promise<WaitlistSummary | null> {
    const result = await this.pool.query<{
      id: string;
      status: 'WAITING';
      joined_at: Date;
      position: number;
    }>(
      `SELECT w.id, w.status, w.joined_at,
         (SELECT count(*)::integer FROM waitlist_entries AS earlier
          WHERE earlier.event_id = w.event_id AND earlier.status = 'WAITING'
            AND (earlier.joined_at, earlier.id) <= (w.joined_at, w.id)) AS position
       FROM waitlist_entries AS w
       WHERE w.event_id = $1 AND w.user_id = $2 AND w.status = 'WAITING'`,
      [eventId, userId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, status: row.status, joinedAt: row.joined_at, position: row.position };
  }
}
