import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ReservationsRepository } from '../../src/modules/reservations/reservations.repository.js';
import { ReservationsService } from '../../src/modules/reservations/reservations.service.js';
import {
  addActiveMember,
  aliceId,
  bobId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('ReservationsService with PostgreSQL', () => {
  let harness: PostgresHarness;
  let service: ReservationsService;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    service = new ReservationsService(new ReservationsRepository(harness.pool));
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('serializes concurrent requests for the final place', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);

    const outcomes = await Promise.all([
      service.reserve(eventId, aliceId, 'alice-final-place'),
      service.reserve(eventId, bobId, 'bob-final-place'),
    ]);

    expect(outcomes.map((outcome) => outcome.body.attendanceStatus).sort()).toEqual([
      'CONFIRMED',
      'WAITLISTED',
    ]);

    const state = await harness.pool.query<{
      confirmed: number;
      waiting: number;
      overlap: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND status = 'WAITING') AS waiting,
         (SELECT count(*)::integer
          FROM reservations AS r
          JOIN waitlist_entries AS w ON w.event_id = r.event_id AND w.user_id = r.user_id
          WHERE r.event_id = $1 AND r.status = 'CONFIRMED' AND w.status = 'WAITING') AS overlap`,
      [eventId],
    );

    expect(state.rows[0]).toEqual({ confirmed: 1, waiting: 1, overlap: 0 });
  });

  it('replays an idempotent reservation without creating another effect', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    const eventId = await createEventFixture(harness.pool, communityId);

    const first = await service.reserve(eventId, aliceId, 'retryable-request');
    const replay = await service.reserve(eventId, aliceId, 'retryable-request');

    expect(replay).toEqual(first);
    const state = await harness.pool.query<{ reservations: number; keys: number }>(
      `SELECT
         (SELECT count(*)::integer FROM reservations WHERE event_id = $1) AS reservations,
         (SELECT count(*)::integer FROM idempotency_keys
          WHERE user_id = $2 AND scope = $3 AND key = $4) AS keys`,
      [eventId, aliceId, `reserve:${eventId}`, 'retryable-request'],
    );
    expect(state.rows[0]).toEqual({ reservations: 1, keys: 1 });
  });

  it('cancels one reservation and atomically promotes the oldest waiting user', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);

    await service.reserve(eventId, aliceId, 'alice-reservation');
    await service.reserve(eventId, bobId, 'bob-waitlist');
    await service.cancelReservation(eventId, aliceId);

    const state = await harness.pool.query<{
      confirmed_user_id: string | null;
      promoted: number;
      notifications: number;
    }>(
      `SELECT
         (SELECT user_id FROM reservations
          WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed_user_id,
         (SELECT count(*)::integer FROM waitlist_entries
          WHERE event_id = $1 AND status = 'PROMOTED') AS promoted,
         (SELECT count(*)::integer FROM notifications
          WHERE user_id = $2 AND type = 'WAITLIST_PROMOTED' AND data->>'eventId' = $1::text)
          AS notifications`,
      [eventId, bobId],
    );

    expect(state.rows[0]).toEqual({
      confirmed_user_id: bobId,
      promoted: 1,
      notifications: 1,
    });
  });

  it('rolls back cancellation and promotion when the final notification write fails', async () => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);

    await service.reserve(eventId, aliceId, 'alice-before-rollback');
    await service.reserve(eventId, bobId, 'bob-before-rollback');

    await harness.pool.query(`
      CREATE FUNCTION phase5_fail_promotion_notification()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.type = 'WAITLIST_PROMOTED' THEN
          RAISE EXCEPTION 'phase5 injected notification failure';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER phase5_fail_promotion_notification_trigger
      BEFORE INSERT ON notifications
      FOR EACH ROW
      EXECUTE FUNCTION phase5_fail_promotion_notification();
    `);

    try {
      await expect(service.cancelReservation(eventId, aliceId)).rejects.toThrow(
        'phase5 injected notification failure',
      );

      const state = await harness.pool.query<{
        alice_confirmed: number;
        bob_confirmed: number;
        bob_waiting: number;
        bob_promoted: number;
        promotion_notifications: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM reservations
            WHERE event_id = $1 AND user_id = $2 AND status = 'CONFIRMED') AS alice_confirmed,
           (SELECT count(*)::integer FROM reservations
            WHERE event_id = $1 AND user_id = $3 AND status = 'CONFIRMED') AS bob_confirmed,
           (SELECT count(*)::integer FROM waitlist_entries
            WHERE event_id = $1 AND user_id = $3 AND status = 'WAITING') AS bob_waiting,
           (SELECT count(*)::integer FROM waitlist_entries
            WHERE event_id = $1 AND user_id = $3 AND status = 'PROMOTED') AS bob_promoted,
           (SELECT count(*)::integer FROM notifications
            WHERE user_id = $3 AND type = 'WAITLIST_PROMOTED') AS promotion_notifications`,
        [eventId, aliceId, bobId],
      );

      expect(state.rows[0]).toEqual({
        alice_confirmed: 1,
        bob_confirmed: 0,
        bob_waiting: 1,
        bob_promoted: 0,
        promotion_notifications: 0,
      });
    } finally {
      await harness.pool.query(`
        DROP TRIGGER IF EXISTS phase5_fail_promotion_notification_trigger ON notifications;
        DROP FUNCTION IF EXISTS phase5_fail_promotion_notification();
      `);
    }
  });
});
