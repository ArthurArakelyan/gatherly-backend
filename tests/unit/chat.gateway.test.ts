import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import pino from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatWebSocketGateway } from '../../src/infrastructure/http/chat-websocket-gateway.js';
import type { ChatService } from '../../src/modules/chat/chat.service.js';
import type {
  ChatPresence,
  ChatSignal,
  ChatSignalPublisher,
  ServerChatEvent,
} from '../../src/modules/chat/chat.types.js';

class FakeSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public bufferedAmount = 0;
  public readonly sent: ServerChatEvent[] = [];
  public readonly closes: { code: number; reason: string }[] = [];
  public pingCount = 0;
  public terminateCount = 0;

  public send(value: string, callback: (error?: Error | null) => void): void {
    this.sent.push(JSON.parse(value) as ServerChatEvent);
    callback(null);
  }

  public close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  public ping(): void {
    this.pingCount += 1;
  }

  public terminate(): void {
    this.terminateCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  public receive(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

const eventId = randomUUID();
const userId = randomUUID();

const createSubject = (
  overrides: {
    bufferedAmount?: number;
    commandLimit?: number;
    heartbeatIntervalMs?: number;
    maxConnectionDurationMs?: number;
    typingTtlMs?: number;
  } = {},
) => {
  const timeline: string[] = [];
  const service = {
    requireAccess: vi.fn(() => {
      timeline.push('authorized');
      return Promise.resolve({ eventId, userId, username: 'alice', role: 'MEMBER' as const });
    }),
    sendMessage: vi.fn(() => {
      timeline.push('committed');
      return Promise.resolve({
        duplicate: false,
        message: {
          id: randomUUID(),
          eventId,
          sender: { id: userId, username: 'alice' },
          body: 'hello',
          deletedAt: null,
          createdAt: new Date().toISOString(),
        },
      });
    }),
    deleteMessage: vi.fn(),
    findMessageForBroadcast: vi.fn(),
  };
  const published: ChatSignal[] = [];
  const signals: ChatSignalPublisher = {
    publish(signal) {
      timeline.push(`published:${signal.kind}`);
      published.push(signal);
    },
  };
  const presence: ChatPresence = {
    join: vi.fn(() => Promise.resolve([userId])),
    renew: vi.fn(() => Promise.resolve()),
    leave: vi.fn(() => Promise.resolve(false)),
  };
  const gateway = new ChatWebSocketGateway(
    service as unknown as ChatService,
    signals,
    presence,
    pino({ enabled: false }),
    {
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10_000,
      maxConnectionDurationMs: overrides.maxConnectionDurationMs ?? 60_000,
      maxBufferedBytes: 100,
      commandLimit: overrides.commandLimit ?? 20,
      commandWindowMs: 1_000,
      typingTtlMs: overrides.typingTtlMs ?? 1_000,
    },
  );
  const socket = new FakeSocket();
  socket.bufferedAmount = overrides.bufferedAmount ?? 0;
  gateway.accept(socket as unknown as WebSocket, { userId, username: 'alice' });
  return { gateway, socket, service, presence, published, timeline };
};

const command = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  requestId: randomUUID(),
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('chat WebSocket gateway', () => {
  it('executes commands in arrival order and publishes only after persistence resolves', async () => {
    const subject = createSubject();
    subject.socket.receive(command('chat.join', { eventId }));
    subject.socket.receive(
      command('chat.message.send', { eventId, clientMessageId: randomUUID(), body: 'hello' }),
    );

    await vi.waitFor(() => {
      expect(subject.service.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(subject.timeline).toEqual([
      'authorized',
      'published:presence.updated',
      'committed',
      'published:message.created',
    ]);
    await subject.gateway.shutdown();
  });

  it('requires joining the exact event and rejects malformed frames without persistence', async () => {
    const subject = createSubject();
    subject.socket.receive(
      command('chat.message.send', { eventId, clientMessageId: randomUUID(), body: 'hello' }),
    );
    subject.socket.receive({ type: 'chat.leave', requestId: randomUUID(), extra: true });

    await vi.waitFor(() => {
      expect(subject.socket.sent.filter(({ type }) => type === 'error')).toHaveLength(2);
    });
    expect(
      subject.socket.sent.some(
        (event) => event.type === 'error' && event.error.code === 'CHAT_NOT_JOINED',
      ),
    ).toBe(true);
    expect(
      subject.socket.sent.some(
        (event) => event.type === 'error' && event.error.code === 'INVALID_CHAT_FRAME',
      ),
    ).toBe(true);
    expect(subject.service.sendMessage).not.toHaveBeenCalled();
    await subject.gateway.shutdown();
  });

  it('auto-expires typing and clears it when leaving', async () => {
    vi.useFakeTimers();
    const subject = createSubject({ typingTtlMs: 50 });
    subject.socket.receive(command('chat.join', { eventId }));
    await vi.advanceTimersByTimeAsync(1);
    subject.socket.receive(command('chat.typing.set', { eventId, isTyping: true }));
    await vi.advanceTimersByTimeAsync(51);

    expect(subject.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'typing.updated', isTyping: true }),
        expect.objectContaining({ kind: 'typing.updated', isTyping: false }),
      ]),
    );
    subject.socket.receive(command('chat.leave'));
    await vi.advanceTimersByTimeAsync(1);
    await subject.gateway.shutdown();
  });

  it('enforces command quota and backpressure close codes', async () => {
    const limited = createSubject({ commandLimit: 1 });
    limited.socket.receive(command('chat.leave'));
    limited.socket.receive(command('chat.leave'));
    await vi.waitFor(() => {
      expect(limited.socket.closes).toContainEqual({ code: 1008, reason: 'rate_limited' });
    });
    await limited.gateway.shutdown();

    const backedUp = createSubject({ bufferedAmount: 101 });
    expect(backedUp.socket.closes).toContainEqual({ code: 1013, reason: 'backpressure' });
    await backedUp.gateway.shutdown();
  });

  it('terminates a missing pong and refreshes a connection at maximum age', async () => {
    vi.useFakeTimers();
    const dead = createSubject({ heartbeatIntervalMs: 10, maxConnectionDurationMs: 1_000 });
    await vi.advanceTimersByTimeAsync(21);
    expect(dead.socket.pingCount).toBe(1);
    expect(dead.socket.terminateCount).toBe(1);
    await dead.gateway.shutdown();

    const aged = createSubject({ heartbeatIntervalMs: 10, maxConnectionDurationMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(aged.socket.sent).toContainEqual({
      type: 'connection.refresh',
      data: { reason: 'connection_age_limit' },
    });
    expect(aged.socket.closes).toContainEqual({ code: 4001, reason: 'refresh_required' });
    await aged.gateway.shutdown();
    await aged.gateway.shutdown();
  });
});
