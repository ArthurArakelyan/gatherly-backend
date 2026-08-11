import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppError } from '../../src/shared/errors/app-error.js';
import { RealtimeService } from '../../src/modules/realtime/realtime.service.js';
import type {
  RealtimeEvent,
  RealtimeEventReader,
  RealtimeStream,
  RealtimeStreamMessage,
} from '../../src/modules/realtime/realtime.types.js';

const userId = '00000000-0000-4000-8000-000000000001';
const notificationId = '10000000-0000-4000-8000-000000000001';

const notificationEvent = (id: string): RealtimeEvent => ({
  id,
  type: 'notification.created',
  data: {
    notification: {
      id: notificationId,
      type: 'RESERVATION_CONFIRMED',
      title: 'Reservation confirmed',
      message: 'Reservation confirmed',
      data: { eventId: '20000000-0000-4000-8000-000000000001' },
      readAt: null,
      createdAt: '2026-08-12T00:00:00.000Z',
    },
  },
  createdAt: new Date('2026-08-12T00:00:00.000Z'),
});

class FakeRealtimeStream implements RealtimeStream {
  public openedWith: number | undefined;
  public readonly messages: RealtimeStreamMessage[] = [];
  public heartbeatCount = 0;
  public closed = false;
  public writable = true;
  private closeListener: (() => void) | undefined;

  public open(retryMilliseconds: number): void {
    this.openedWith = retryMilliseconds;
  }

  public send(message: RealtimeStreamMessage): boolean {
    this.messages.push(message);
    return this.writable;
  }

  public heartbeat(): boolean {
    this.heartbeatCount += 1;
    return this.writable;
  }

  public onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  public close(): void {
    this.closed = true;
  }

  public disconnect(): void {
    this.closeListener?.();
  }
}

const createReader = (): {
  reader: RealtimeEventReader;
  isActiveUser: ReturnType<typeof vi.fn<(requestedUserId: string) => Promise<boolean>>>;
  findVisibleAfter: ReturnType<
    typeof vi.fn<
      (requestedUserId: string, afterId: bigint, limit: number) => Promise<RealtimeEvent[]>
    >
  >;
} => {
  const isActiveUser = vi
    .fn<(requestedUserId: string) => Promise<boolean>>()
    .mockResolvedValue(true);
  const findVisibleAfter = vi
    .fn<(requestedUserId: string, afterId: bigint, limit: number) => Promise<RealtimeEvent[]>>()
    .mockResolvedValue([]);
  return { reader: { isActiveUser, findVisibleAfter }, isActiveUser, findVisibleAfter };
};

const createService = (
  reader: RealtimeEventReader,
  overrides: Partial<{
    heartbeatIntervalMs: number;
    retryMs: number;
    replayBatchSize: number;
    maxConnectionsPerUser: number;
    maxConnectionDurationMs: number;
  }> = {},
): RealtimeService =>
  new RealtimeService(reader, pino({ enabled: false }), {
    heartbeatIntervalMs: 5_000,
    retryMs: 3_000,
    replayBatchSize: 2,
    maxConnectionsPerUser: 1,
    maxConnectionDurationMs: 60_000,
    ...overrides,
  });

describe('RealtimeService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays visible events in ordered batches and advances the cursor', async () => {
    const { reader, findVisibleAfter } = createReader();
    findVisibleAfter
      .mockResolvedValueOnce([notificationEvent('1'), notificationEvent('2')])
      .mockResolvedValueOnce([notificationEvent('3')])
      .mockResolvedValueOnce([]);
    const service = createService(reader);
    const stream = new FakeRealtimeStream();

    await service.connect(userId, 0n, stream);
    await vi.waitFor(() => {
      expect(stream.messages.map((message) => message.id)).toEqual(['1', '2', '3']);
    });

    expect(stream.openedWith).toBe(3_000);
    expect(findVisibleAfter.mock.calls.slice(0, 2).map((call) => call[1])).toEqual([0n, 2n]);
    stream.disconnect();
  });

  it('counts pending handshakes and releases a connection slot on disconnect', async () => {
    const { reader, isActiveUser } = createReader();
    let resolveAuthentication!: (active: boolean) => void;
    isActiveUser.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAuthentication = resolve;
        }),
    );
    const service = createService(reader);
    const firstStream = new FakeRealtimeStream();
    const pendingConnection = service.connect(userId, 0n, firstStream);
    await vi.waitFor(() => {
      expect(isActiveUser).toHaveBeenCalledOnce();
    });

    await expect(service.connect(userId, 0n, new FakeRealtimeStream())).rejects.toMatchObject({
      code: 'SSE_CONNECTION_LIMIT',
    } satisfies Partial<AppError>);

    resolveAuthentication(true);
    await pendingConnection;
    firstStream.disconnect();

    const replacement = new FakeRealtimeStream();
    await expect(service.connect(userId, 0n, replacement)).resolves.toBeUndefined();
    replacement.disconnect();
  });

  it('closes a backpressured stream without retaining its connection slot', async () => {
    const { reader, findVisibleAfter } = createReader();
    findVisibleAfter.mockResolvedValueOnce([notificationEvent('1')]).mockResolvedValue([]);
    const service = createService(reader);
    const blocked = new FakeRealtimeStream();
    blocked.writable = false;

    await service.connect(userId, 0n, blocked);

    expect(blocked.closed).toBe(true);
    const replacement = new FakeRealtimeStream();
    await expect(service.connect(userId, 0n, replacement)).resolves.toBeUndefined();
    replacement.disconnect();
  });

  it('closes an active stream when account authorization is revoked', async () => {
    const { reader, isActiveUser } = createReader();
    isActiveUser.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const service = createService(reader);
    const stream = new FakeRealtimeStream();
    await service.connect(userId, 0n, stream);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(stream.messages).toContainEqual({
      event: 'stream.closed',
      data: { reason: 'authorization_revoked' },
    });
    expect(stream.closed).toBe(true);
  });

  it('forces a fresh handshake at the maximum connection age', async () => {
    const { reader } = createReader();
    const service = createService(reader, {
      heartbeatIntervalMs: 60_000,
      maxConnectionDurationMs: 60_000,
    });
    const stream = new FakeRealtimeStream();
    await service.connect(userId, 0n, stream);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(stream.messages).toContainEqual({
      event: 'stream.refresh-required',
      data: { reason: 'connection_age_limit' },
    });
    expect(stream.closed).toBe(true);
  });

  it('serializes overlapping wake-ups and reruns the drain once', async () => {
    const { reader, findVisibleAfter } = createReader();
    let resolveDrain!: (events: RealtimeEvent[]) => void;
    findVisibleAfter
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<RealtimeEvent[]>((resolve) => {
            resolveDrain = resolve;
          }),
      )
      .mockResolvedValue([]);
    const service = createService(reader);
    const stream = new FakeRealtimeStream();
    await service.connect(userId, 0n, stream);
    await vi.waitFor(() => {
      expect(findVisibleAfter).toHaveBeenCalledTimes(2);
    });

    service.wakeAll();
    service.wakeAll();
    resolveDrain([]);
    await vi.waitFor(() => {
      expect(findVisibleAfter).toHaveBeenCalledTimes(3);
    });

    stream.disconnect();
  });

  it('shuts down each stream once and rejects new connections', async () => {
    const { reader } = createReader();
    const service = createService(reader);
    const stream = new FakeRealtimeStream();
    await service.connect(userId, 0n, stream);

    service.shutdown();
    service.shutdown();

    expect(stream.messages.filter((message) => message.event === 'stream.closed')).toHaveLength(1);
    expect(stream.closed).toBe(true);
    await expect(service.connect(userId, 0n, new FakeRealtimeStream())).rejects.toMatchObject({
      code: 'SERVER_DRAINING',
    } satisfies Partial<AppError>);
  });
});
