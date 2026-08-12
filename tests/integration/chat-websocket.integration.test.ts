import { createHash, randomUUID } from 'node:crypto';

import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addActiveMember,
  aliceId,
  bobId,
  createCommunityFixture,
  createEventFixture,
} from '../fixtures/database.js';
import {
  chatProtocol,
  connectChatSocket,
  rejectedUpgradeStatus,
  startChatWebSocketHarness,
  type ChatWebSocketHarness,
} from '../helpers/chat-websocket.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';

const closeEvent = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });

const authenticatedUser = (id: string, username: string) => ({
  id,
  username,
  status: 'ACTIVE' as const,
  platformRole: 'USER' as const,
  createdAt: new Date('2026-08-12T00:00:00.000Z'),
});

describe('chat WebSocket wire behavior', () => {
  let postgres: PostgresHarness;
  let redis: RedisHarness;
  const subjects: ChatWebSocketHarness[] = [];
  const clients: WebSocket[] = [];

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgresHarness(), startRedisHarness()]);
  }, 60_000);

  beforeEach(async () => {
    await Promise.all([postgres.reset(), redis.reset()]);
    await postgres.seed();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      if (client.readyState === WebSocket.OPEN) client.close();
    }
    await Promise.all(subjects.splice(0).map((subject) => subject.stop()));
  });

  afterAll(async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  });

  const startSubject = async (
    configuration: Parameters<typeof startChatWebSocketHarness>[2] = {},
  ): Promise<ChatWebSocketHarness> => {
    const subject = await startChatWebSocketHarness(postgres, redis, configuration);
    subjects.push(subject);
    return subject;
  };

  const connect = async (subject: ChatWebSocketHarness, user: { id: string; username: string }) => {
    const { ticket } = await subject.tickets.issue(authenticatedUser(user.id, user.username));
    const connected = await connectChatSocket(subject.baseUrl, ticket);
    clients.push(connected.socket);
    return connected;
  };

  it('rejects the wrong path, Origin, base protocol, malformed ticket, and reused ticket', async () => {
    const subject = await startSubject();
    const { ticket } = await subject.tickets.issue(authenticatedUser(aliceId, 'alice'));

    await expect(
      rejectedUpgradeStatus(subject.baseUrl, { ticket, path: '/api/not-chat' }),
    ).resolves.toBe(404);
    await expect(
      rejectedUpgradeStatus(subject.baseUrl, { ticket, origin: 'https://evil.example' }),
    ).resolves.toBe(403);
    await expect(
      rejectedUpgradeStatus(subject.baseUrl, {
        ticket,
        protocols: [`gatherly.ticket.${ticket}`, 'wrong.protocol'],
      }),
    ).resolves.toBe(401);
    await expect(
      rejectedUpgradeStatus(subject.baseUrl, {
        protocols: [chatProtocol, 'gatherly.ticket.not-valid'],
      }),
    ).resolves.toBe(401);

    const connected = await connectChatSocket(subject.baseUrl, ticket);
    clients.push(connected.socket);
    await expect(connected.next('connection.ready')).resolves.toEqual({
      type: 'connection.ready',
      data: { protocol: chatProtocol },
    });
    expect(connected.socket.protocol).toBe(chatProtocol);
    expect(JSON.stringify(await subject.tickets.consume(ticket))).not.toContain(ticket);
    await expect(rejectedUpgradeStatus(subject.baseUrl, { ticket })).resolves.toBe(401);
  });

  it('rejects an expired ticket before upgrading', async () => {
    const subject = await startSubject();
    const { ticket } = await subject.tickets.issue(authenticatedUser(aliceId, 'alice'));
    const digest = createHash('sha256').update(ticket).digest('hex');
    await redis.client.del(`gatherly:v1:websocket-ticket:${digest}`);
    await expect(rejectedUpgradeStatus(subject.baseUrl, { ticket })).resolves.toBe(401);
  });

  it('returns safe frame errors and closes binary and oversized frames with standard codes', async () => {
    const subject = await startSubject({ maxPayloadBytes: 128 });
    const malformed = await connect(subject, { id: aliceId, username: 'alice' });
    await malformed.next('connection.ready');
    malformed.socket.send('{bad json');
    await expect(malformed.next('error')).resolves.toMatchObject({
      error: { code: 'INVALID_CHAT_FRAME' },
    });
    malformed.socket.send(
      JSON.stringify({ type: 'chat.leave', requestId: randomUUID(), unexpected: true }),
    );
    await expect(malformed.next('error')).resolves.toMatchObject({
      error: { code: 'INVALID_CHAT_FRAME' },
    });

    const binary = await connect(subject, { id: aliceId, username: 'alice' });
    await binary.next('connection.ready');
    const binaryClosed = closeEvent(binary.socket);
    binary.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    await expect(binaryClosed).resolves.toEqual({ code: 1003, reason: 'text_frames_only' });

    const oversized = await connect(subject, { id: aliceId, username: 'alice' });
    await oversized.next('connection.ready');
    const oversizedClosed = closeEvent(oversized.socket);
    oversized.socket.send('x'.repeat(129));
    await expect(oversizedClosed).resolves.toMatchObject({ code: 1009 });
  });

  it('persists before fan-out, orders commands, and deduplicates an ambiguous retry', async () => {
    const subject = await startSubject();
    const communityId = await createCommunityFixture(postgres.pool);
    await addActiveMember(postgres.pool, communityId, bobId);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const alice = await connect(subject, { id: aliceId, username: 'alice' });
    const bob = await connect(subject, { id: bobId, username: 'bob' });
    await Promise.all([alice.next('connection.ready'), bob.next('connection.ready')]);

    const prematureRequestId = randomUUID();
    bob.socket.send(
      JSON.stringify({
        type: 'chat.message.send',
        requestId: prematureRequestId,
        eventId,
        clientMessageId: randomUUID(),
        body: 'premature',
      }),
    );
    await expect(bob.next('error')).resolves.toMatchObject({
      requestId: prematureRequestId,
      error: { code: 'CHAT_NOT_JOINED' },
    });

    for (const connection of [alice, bob]) {
      connection.socket.send(
        JSON.stringify({ type: 'chat.join', requestId: randomUUID(), eventId }),
      );
      await connection.next('chat.joined');
    }

    const clientMessageId = randomUUID();
    const requestId = randomUUID();
    bob.socket.send(
      JSON.stringify({
        type: 'chat.message.send',
        requestId,
        eventId,
        clientMessageId,
        body: 'durable first',
      }),
    );
    await expect(bob.next('chat.message.accepted')).resolves.toMatchObject({
      requestId,
      data: { clientMessageId, duplicate: false },
    });
    const broadcast = await alice.next('chat.message.created');
    if (broadcast.type !== 'chat.message.created') throw new Error('Expected created event');
    const durable = await postgres.pool.query<{ body: string }>(
      `SELECT body FROM chat_messages WHERE id = $1`,
      [broadcast.data.message.id],
    );
    expect(durable.rows[0]?.body).toBe('durable first');

    bob.socket.send(
      JSON.stringify({
        type: 'chat.message.send',
        requestId: randomUUID(),
        eventId,
        clientMessageId,
        body: 'durable first',
      }),
    );
    await expect(bob.next('chat.message.accepted')).resolves.toMatchObject({
      data: { messageId: broadcast.data.message.id, duplicate: true },
    });
    const count = await postgres.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM chat_messages`,
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('reauthorizes a joined socket and closes it after membership revocation', async () => {
    const subject = await startSubject({ heartbeatIntervalMs: 20 });
    const communityId = await createCommunityFixture(postgres.pool);
    await addActiveMember(postgres.pool, communityId, bobId);
    const eventId = await createEventFixture(postgres.pool, communityId);
    const bob = await connect(subject, { id: bobId, username: 'bob' });
    await bob.next('connection.ready');
    bob.socket.send(JSON.stringify({ type: 'chat.join', requestId: randomUUID(), eventId }));
    await bob.next('chat.joined');

    await postgres.pool.query(
      `UPDATE community_memberships SET status = 'SUSPENDED'
       WHERE community_id = $1 AND user_id = $2`,
      [communityId, bobId],
    );
    const closed = closeEvent(bob.socket);
    await expect(closed).resolves.toEqual({ code: 4003, reason: 'authorization_revoked' });
  });

  it('sends refresh at maximum age and closes upgraded sockets during shutdown', async () => {
    const agedSubject = await startSubject({
      heartbeatIntervalMs: 20,
      maxConnectionDurationMs: 20,
    });
    const aged = await connect(agedSubject, { id: aliceId, username: 'alice' });
    await aged.next('connection.ready');
    await expect(aged.next('connection.refresh')).resolves.toMatchObject({
      data: { reason: 'connection_age_limit' },
    });
    await expect(closeEvent(aged.socket)).resolves.toEqual({
      code: 4001,
      reason: 'refresh_required',
    });

    const shutdownSubject = await startSubject();
    const live = await connect(shutdownSubject, { id: aliceId, username: 'alice' });
    await live.next('connection.ready');
    const closed = closeEvent(live.socket);
    await shutdownSubject.stop();
    subjects.splice(subjects.indexOf(shutdownSubject), 1);
    await expect(closed).resolves.toEqual({ code: 1001, reason: 'server_shutdown' });
    await shutdownSubject.stop();
  });
});
