import { createHash, randomUUID } from 'node:crypto';

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisChatBus, createChatSubscriber } from '../../src/infrastructure/redis/chat-bus.js';
import { RedisChatPresence } from '../../src/infrastructure/redis/chat-presence.js';
import {
  closeRedisClient,
  type GatherlyRedisClient,
} from '../../src/infrastructure/redis/client.js';
import { WebSocketTicketStore } from '../../src/infrastructure/redis/websocket-ticket-store.js';
import type { ChatSignal } from '../../src/modules/chat/chat.types.js';
import { aliceId, bobId } from '../fixtures/database.js';
import { type RedisHarness, startRedisHarness } from '../helpers/redis.js';

const logger = pino({ enabled: false });
const authenticatedUser = (id: string, username: string) => ({
  id,
  username,
  status: 'ACTIVE' as const,
  platformRole: 'USER' as const,
  createdAt: new Date('2026-08-12T00:00:00.000Z'),
});

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Redis condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

describe('chat Redis behavior', () => {
  let harness: RedisHarness;
  const extraClients: GatherlyRedisClient[] = [];
  const buses: RedisChatBus[] = [];

  beforeAll(async () => {
    harness = await startRedisHarness();
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.close()));
    await Promise.all(extraClients.splice(0).map(closeRedisClient));
    await harness.stop();
  });

  const duplicate = async (): Promise<GatherlyRedisClient> => {
    const client = harness.client.duplicate();
    await client.connect();
    extraClients.push(client);
    return client;
  };

  it('stores random tickets only by digest and consumes one exactly once', async () => {
    const store = new WebSocketTicketStore(harness.client, logger, 30);
    const first = await store.issue(authenticatedUser(aliceId, 'alice'));
    const second = await store.issue(authenticatedUser(aliceId, 'alice'));
    expect(first.ticket).not.toBe(second.ticket);
    expect(first.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const digest = createHash('sha256').update(first.ticket).digest('hex');
    const keys = await harness.client.keys('gatherly:v1:websocket-ticket:*');
    expect(keys).toContain(`gatherly:v1:websocket-ticket:${digest}`);
    expect(keys.join(' ')).not.toContain(first.ticket);

    const results = await Promise.all([store.consume(first.ticket), store.consume(first.ticket)]);
    expect(results.filter((result) => result !== null)).toEqual([
      { userId: aliceId, username: 'alice' },
    ]);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it('expires tickets and rejects corrupt stored values', async () => {
    const store = new WebSocketTicketStore(harness.client, logger, 30);
    const issued = await store.issue(authenticatedUser(aliceId, 'alice'));
    const digest = createHash('sha256').update(issued.ticket).digest('hex');
    const key = `gatherly:v1:websocket-ticket:${digest}`;
    await harness.client.pExpire(key, 1);
    await waitFor(async () => (await harness.client.exists(key)) === 0);
    await expect(store.consume(issued.ticket)).resolves.toBeNull();

    const corruptTicket = 'a'.repeat(43);
    const corruptDigest = createHash('sha256').update(corruptTicket).digest('hex');
    await harness.client.set(`gatherly:v1:websocket-ticket:${corruptDigest}`, '{bad json');
    await expect(store.consume(corruptTicket)).resolves.toBeNull();
  });

  it('fans validated signals across instances and also delivers locally', async () => {
    const publisherTwo = await duplicate();
    const subscriberOne = createChatSubscriber(harness.client, logger);
    const subscriberTwo = createChatSubscriber(publisherTwo, logger);
    const first = new RedisChatBus(harness.client, subscriberOne, logger);
    const second = new RedisChatBus(publisherTwo, subscriberTwo, logger);
    buses.push(first, second);
    const local = vi.fn(() => Promise.resolve());
    const remote = vi.fn(() => Promise.resolve());
    first.start({ handleSignal: local });
    second.start({ handleSignal: remote });

    await waitFor(async () => {
      const counts = await harness.client.pubSubNumSub('gatherly:chat:signals:v1');
      return counts['gatherly:chat:signals:v1'] === 2;
    });

    const signal: ChatSignal = {
      kind: 'message.created',
      eventId: randomUUID(),
      messageId: randomUUID(),
    };
    first.publish(signal);
    await waitFor(() => Promise.resolve(remote.mock.calls.length === 1));

    expect(local).toHaveBeenCalledWith(signal);
    expect(remote).toHaveBeenCalledWith(signal);
  });

  it('keeps a user online while any connection remains and expires crashed leases', async () => {
    const presence = new RedisChatPresence(harness.client, logger, 80);
    const eventId = randomUUID();
    const firstConnection = randomUUID();
    const secondConnection = randomUUID();

    await expect(presence.join(eventId, aliceId, firstConnection)).resolves.toEqual([aliceId]);
    await expect(presence.join(eventId, aliceId, secondConnection)).resolves.toEqual([aliceId]);
    await expect(presence.leave(eventId, aliceId, firstConnection)).resolves.toBe(true);
    await expect(presence.leave(eventId, aliceId, secondConnection)).resolves.toBe(false);

    await presence.join(eventId, aliceId, randomUUID());
    const observer = new RedisChatPresence(harness.client, logger, 80);
    await waitFor(async () => {
      const snapshot = await observer.join(eventId, bobId, randomUUID());
      return !snapshot.includes(aliceId);
    });

    await harness.client.flushDb();
    const afterFlush = new RedisChatPresence(harness.client, logger, 80);
    await expect(afterFlush.join(eventId, bobId, randomUUID())).resolves.toEqual([bobId]);
  });
});
