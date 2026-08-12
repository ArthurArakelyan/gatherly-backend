import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ChatRepository } from '../../src/modules/chat/chat.repository.js';
import {
  addActiveMember,
  aliceId,
  bobId,
  carolId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('chat PostgreSQL behavior', () => {
  let harness: PostgresHarness;
  let repository: ChatRepository;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    repository = new ChatRepository(harness.pool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
    await harness.seed();
  });

  afterAll(async () => {
    await harness.stop();
  });

  const createAccessibleEvent = async (): Promise<{ communityId: string; eventId: string }> => {
    const communityId = await createCommunityFixture(harness.pool);
    await addActiveMember(harness.pool, communityId, bobId);
    const eventId = await createEventFixture(harness.pool, communityId);
    return { communityId, eventId };
  };

  it('requires current active account, community, membership, and event state', async () => {
    const { communityId, eventId } = await createAccessibleEvent();

    await expect(repository.findAccess(eventId, aliceId)).resolves.toMatchObject({
      eventId,
      userId: aliceId,
      role: 'OWNER',
    });
    await expect(repository.findAccess(eventId, carolId)).resolves.toBeNull();

    await harness.pool.query(
      `UPDATE community_memberships SET status = 'SUSPENDED'
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, bobId],
    );
    await expect(repository.findAccess(eventId, bobId)).resolves.toBeNull();

    await harness.pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [aliceId]);
    await expect(repository.findAccess(eventId, aliceId)).resolves.toBeNull();

    await harness.pool.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [aliceId]);
    await harness.pool.query(`UPDATE events SET status = 'CANCELLED' WHERE id = $1`, [eventId]);
    await expect(repository.findAccess(eventId, aliceId)).resolves.toBeNull();
  });

  it('deduplicates concurrent retries and rejects changed content for one client ID', async () => {
    const { eventId } = await createAccessibleEvent();
    const clientMessageId = randomUUID();

    const results = await Promise.all([
      repository.createMessage(eventId, bobId, clientMessageId, 'same body'),
      repository.createMessage(eventId, bobId, clientMessageId, 'same body'),
    ]);

    expect(new Set(results.map((result) => result?.message.id))).toHaveProperty('size', 1);
    expect(results.map((result) => result?.duplicate).sort()).toEqual([false, true]);
    await expect(
      repository.createMessage(eventId, bobId, clientMessageId, 'changed body'),
    ).rejects.toMatchObject({ code: 'CHAT_CLIENT_MESSAGE_ID_REUSED', status: 409 });

    const count = await harness.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM chat_messages`,
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('paginates equal timestamps by timestamp and UUID without gaps or duplicates', async () => {
    const { eventId } = await createAccessibleEvent();
    const messages = await Promise.all(
      ['one', 'two', 'three'].map((body) =>
        repository.createMessage(eventId, bobId, randomUUID(), body),
      ),
    );
    const ids = messages.map((result) => result?.message.id);
    await harness.pool.query(`UPDATE chat_messages SET created_at = '2026-08-12T12:00:00.000Z'`);

    const first = await repository.findHistory(eventId, bobId, undefined, 2);
    const cursor = first?.nextCursor;
    if (first === null || cursor === null || cursor === undefined) {
      throw new Error('Expected a second page');
    }
    const second = await repository.findHistory(eventId, bobId, cursor, 2);
    if (second === null) throw new Error('Expected history access');

    const actualIds = [...first.items, ...second.items].map(({ id }) => id);
    expect(actualIds).toEqual([...ids].sort().reverse());
    expect(new Set(actualIds).size).toBe(3);
    expect(second.nextCursor).toBeNull();

    await expect(repository.findHistory(eventId, bobId, 'not-a-cursor', 2)).rejects.toMatchObject({
      code: 'INVALID_CHAT_CURSOR',
    });
  });

  it('soft-deletes in the target event and appends exactly one audit row', async () => {
    const first = await createAccessibleEvent();
    const secondCommunityId = await createCommunityFixture(harness.pool);
    const secondEventId = await createEventFixture(harness.pool, secondCommunityId);
    const created = await repository.createMessage(first.eventId, bobId, randomUUID(), 'remove me');
    if (created === null) throw new Error('Expected message creation');

    await expect(
      repository.deleteMessage(secondEventId, created.message.id, aliceId),
    ).resolves.toBeNull();
    await expect(
      repository.deleteMessage(first.eventId, created.message.id, carolId),
    ).resolves.toBeNull();

    const [a, b] = await Promise.all([
      repository.deleteMessage(first.eventId, created.message.id, aliceId),
      repository.deleteMessage(first.eventId, created.message.id, aliceId),
    ]);
    expect([a, b].map((result) => (typeof result === 'object' ? result?.changed : result))).toEqual(
      expect.arrayContaining([true, false]),
    );

    const durable = await harness.pool.query<{
      body: string;
      deleted_at: Date | null;
      deleted_by_user_id: string | null;
      audits: number;
    }>(
      `SELECT message.body,
              message.deleted_at,
              message.deleted_by_user_id,
              (SELECT count(*)::integer FROM chat_moderation_actions
               WHERE message_id = message.id) AS audits
       FROM chat_messages AS message
       WHERE message.id = $1`,
      [created.message.id],
    );
    expect(durable.rows[0]).toMatchObject({
      body: 'remove me',
      deleted_by_user_id: aliceId,
      audits: 1,
    });
    expect(durable.rows[0]?.deleted_at).toBeInstanceOf(Date);

    const history = await repository.findHistory(first.eventId, bobId, undefined, 10);
    expect(history?.items[0]).toMatchObject({ body: null });
  });

  it('lets an author delete their message but denies an ordinary member deleting another', async () => {
    const { eventId } = await createAccessibleEvent();
    const aliceMessage = await repository.createMessage(eventId, aliceId, randomUUID(), 'owner');
    const bobMessage = await repository.createMessage(eventId, bobId, randomUUID(), 'member');
    if (aliceMessage === null || bobMessage === null) throw new Error('Expected messages');

    await expect(repository.deleteMessage(eventId, aliceMessage.message.id, bobId)).resolves.toBe(
      'FORBIDDEN',
    );
    await expect(
      repository.deleteMessage(eventId, bobMessage.message.id, bobId),
    ).resolves.toMatchObject({ changed: true });
  });

  it('serializes a membership revocation before a send using the membership row lock', async () => {
    const { communityId, eventId } = await createAccessibleEvent();
    const revocation = await harness.pool.connect();
    try {
      await revocation.query('BEGIN');
      await revocation.query(
        `UPDATE community_memberships SET status = 'SUSPENDED'
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, bobId],
      );

      const send = repository.createMessage(eventId, bobId, randomUUID(), 'too late');
      await revocation.query('COMMIT');

      await expect(send).resolves.toBeNull();
      const count = await harness.pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM chat_messages`,
      );
      expect(count.rows[0]?.count).toBe(0);
    } finally {
      revocation.release();
    }
  });

  it('rolls message insertion back completely when the transaction fails', async () => {
    const { eventId } = await createAccessibleEvent();
    await harness.pool.query(`
      CREATE FUNCTION phase6_fail_chat_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected chat failure';
      END;
      $$;
      CREATE TRIGGER phase6_fail_chat_insert_trigger
      BEFORE INSERT ON chat_messages
      FOR EACH ROW EXECUTE FUNCTION phase6_fail_chat_insert();
    `);

    try {
      await expect(
        repository.createMessage(eventId, bobId, randomUUID(), 'rollback'),
      ).rejects.toThrow('injected chat failure');
      const state = await harness.pool.query<{ conversations: number; messages: number }>(
        `SELECT
           (SELECT count(*)::integer FROM event_conversations) AS conversations,
           (SELECT count(*)::integer FROM chat_messages) AS messages`,
      );
      expect(state.rows[0]).toEqual({ conversations: 0, messages: 0 });
    } finally {
      await harness.pool.query(`DROP TRIGGER phase6_fail_chat_insert_trigger ON chat_messages`);
      await harness.pool.query(`DROP FUNCTION phase6_fail_chat_insert()`);
    }
  });
});
