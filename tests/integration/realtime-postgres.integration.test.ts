import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeRepository } from '../../src/modules/realtime/realtime.repository.js';
import { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import {
  addActiveMember,
  aliceId,
  bobId,
  carolId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

const insertPersonalEvent = async (
  harness: PostgresHarness,
  userId: string,
  notificationId: string,
): Promise<string> => {
  const result = await harness.pool.query<{ id: string }>(
    `INSERT INTO realtime_events (type, audience_user_id, payload)
     VALUES (
       'notification.created', $1,
       jsonb_build_object(
         'notification', jsonb_build_object(
           'id', $2::text,
           'type', 'RESERVATION_CONFIRMED',
           'title', 'Reservation confirmed',
           'message', 'Reservation confirmed',
           'data', '{}'::jsonb,
           'readAt', NULL,
           'createdAt', '2026-08-12T00:00:00.000Z'
         )
       )
     )
     RETURNING id::text`,
    [userId, notificationId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Personal realtime fixture insert returned no row');
  return id;
};

const insertCommunityEvent = async (
  harness: PostgresHarness,
  communityId: string,
  eventId: string,
  confirmedCount: number,
): Promise<string> => {
  const result = await harness.pool.query<{ id: string }>(
    `INSERT INTO realtime_events (type, community_id, payload)
     VALUES (
       'event.attendance.updated', $1,
       jsonb_build_object(
         'eventId', $2::text,
         'confirmedCount', $3::integer,
         'waitingCount', 0,
         'capacity', 5
       )
     )
     RETURNING id::text`,
    [communityId, eventId, confirmedCount],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Community realtime fixture insert returned no row');
  return id;
};

describe('realtime PostgreSQL behavior', () => {
  let harness: PostgresHarness;

  beforeAll(async () => {
    harness = await startPostgresHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('orders replay and filters personal and community audiences by current role', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);
    const repository = new RealtimeRepository(harness.pool);

    const alicePersonalId = await insertPersonalEvent(
      harness,
      aliceId,
      '10000000-0000-4000-8000-000000000001',
    );
    const bobPersonalId = await insertPersonalEvent(
      harness,
      bobId,
      '10000000-0000-4000-8000-000000000002',
    );
    const communityEventId = await insertCommunityEvent(harness, communityId, eventId, 1);

    const aliceEvents = await repository.findVisibleAfter(aliceId, 0n, 100);
    const bobEvents = await repository.findVisibleAfter(bobId, 0n, 100);
    const carolEvents = await repository.findVisibleAfter(carolId, 0n, 100);

    expect(aliceEvents.map((event) => event.id)).toEqual([alicePersonalId, communityEventId]);
    expect(bobEvents.map((event) => event.id)).toEqual([bobPersonalId]);
    expect(carolEvents).toEqual([]);

    await harness.pool.query(
      `UPDATE community_memberships SET role = 'ORGANIZER', updated_at = now()
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, bobId],
    );
    const authorizedId = await insertCommunityEvent(harness, communityId, eventId, 2);
    expect(
      (await repository.findVisibleAfter(bobId, BigInt(bobPersonalId), 100)).map(({ id }) => id),
    ).toContain(authorizedId);

    await harness.pool.query(
      `UPDATE community_memberships SET role = 'MEMBER', updated_at = now()
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, bobId],
    );
    const deniedId = await insertCommunityEvent(harness, communityId, eventId, 3);
    expect(
      (await repository.findVisibleAfter(bobId, BigInt(authorizedId), 100)).map(({ id }) => id),
    ).not.toContain(deniedId);

    await harness.pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [aliceId]);
    expect(await repository.findVisibleAfter(aliceId, 0n, 100)).toEqual([]);
  });

  it('commits notification and counter events with concurrent reservation truth', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId, aliceId, 1);
    const wake = vi.fn();
    const service = new ReservationsService(new ReservationsRepository(harness.pool), { wake });

    const outcomes = await Promise.all([
      service.reserve(eventId, aliceId, 'realtime-race-alice'),
      service.reserve(eventId, bobId, 'realtime-race-bob'),
    ]);

    expect(outcomes.map(({ body }) => body.attendanceStatus).sort()).toEqual([
      'CONFIRMED',
      'WAITLISTED',
    ]);
    expect(wake).toHaveBeenCalledTimes(2);

    const journal = await harness.pool.query<{
      type: string;
      payload: { confirmedCount?: number; waitingCount?: number; capacity?: number };
    }>(
      `SELECT type, payload
       FROM realtime_events
       ORDER BY id ASC`,
    );
    expect(journal.rows).toHaveLength(4);
    expect(journal.rows.filter(({ type }) => type === 'notification.created')).toHaveLength(2);
    expect(journal.rows.at(-1)).toMatchObject({
      type: 'event.attendance.updated',
      payload: { confirmedCount: 1, waitingCount: 1, capacity: 1 },
    });

    const beforeReplayCount = journal.rows.length;
    await service.reserve(eventId, aliceId, 'realtime-race-alice');
    const afterReplay = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM realtime_events`,
    );
    expect(afterReplay.rows[0]?.count).toBe(beforeReplayCount);
  });

  it('rolls back business, notification, idempotency, and journal rows together', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventId = await createEventFixture(harness.pool, communityId);
    const service = new ReservationsService(new ReservationsRepository(harness.pool));

    await harness.pool.query(`
      CREATE FUNCTION phase6_fail_attendance_realtime_event()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.type = 'event.attendance.updated' THEN
          RAISE EXCEPTION 'phase6 injected realtime journal failure';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER phase6_fail_attendance_realtime_event_trigger
      BEFORE INSERT ON realtime_events
      FOR EACH ROW
      EXECUTE FUNCTION phase6_fail_attendance_realtime_event();
    `);

    try {
      await expect(service.reserve(eventId, aliceId, 'realtime-rollback')).rejects.toThrow(
        'phase6 injected realtime journal failure',
      );

      const state = await harness.pool.query<{
        reservations: number;
        notifications: number;
        idempotency_keys: number;
        realtime_events: number;
      }>(`SELECT
          (SELECT count(*)::integer FROM reservations) AS reservations,
          (SELECT count(*)::integer FROM notifications) AS notifications,
          (SELECT count(*)::integer FROM idempotency_keys) AS idempotency_keys,
          (SELECT count(*)::integer FROM realtime_events) AS realtime_events`);
      expect(state.rows[0]).toEqual({
        reservations: 0,
        notifications: 0,
        idempotency_keys: 0,
        realtime_events: 0,
      });
    } finally {
      await harness.pool.query(`
        DROP TRIGGER IF EXISTS phase6_fail_attendance_realtime_event_trigger ON realtime_events;
        DROP FUNCTION IF EXISTS phase6_fail_attendance_realtime_event();
      `);
    }
  });

  it('journals one promotion notification and the final organizer counts on cancellation', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);
    const service = new ReservationsService(new ReservationsRepository(harness.pool));
    await service.reserve(eventId, aliceId, 'promotion-alice');
    await service.reserve(eventId, bobId, 'promotion-bob');
    const before = await harness.pool.query<{ maximum: string }>(
      `SELECT max(id)::text AS maximum FROM realtime_events`,
    );
    const cursor = before.rows[0]?.maximum;
    if (cursor === undefined) throw new Error('Expected a realtime cursor before cancellation');

    await service.cancelReservation(eventId, aliceId);

    const rows = await harness.pool.query<{
      type: string;
      payload: {
        notification?: { type: string };
        confirmedCount?: number;
        waitingCount?: number;
      };
    }>(`SELECT type, payload FROM realtime_events WHERE id > $1 ORDER BY id`, [cursor]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      type: 'notification.created',
      payload: { notification: { type: 'WAITLIST_PROMOTED' } },
    });
    expect(rows.rows[1]).toMatchObject({
      type: 'event.attendance.updated',
      payload: { confirmedCount: 1, waitingCount: 0 },
    });
  });
});
