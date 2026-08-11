import type { Logger } from 'pino';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  RealtimeEvent,
  RealtimeEventReader,
  RealtimeStream,
  RealtimeWakeupTarget,
} from './realtime.types.js';

interface RealtimeConfiguration {
  heartbeatIntervalMs: number;
  retryMs: number;
  replayBatchSize: number;
  maxConnectionsPerUser: number;
  maxConnectionDurationMs: number;
}

interface Session {
  key: symbol;
  userId: string;
  cursor: bigint;
  stream: RealtimeStream;
  openedAt: number;
  timer: NodeJS.Timeout | undefined;
  draining: boolean;
  drainAgain: boolean;
  closed: boolean;
}

export class RealtimeService implements RealtimeWakeupTarget {
  private readonly sessions = new Map<symbol, Session>();
  private readonly pendingConnectionsByUser = new Map<string, number>();
  private acceptingConnections = true;

  public constructor(
    private readonly repository: RealtimeEventReader,
    private readonly logger: Logger,
    private readonly configuration: RealtimeConfiguration,
  ) {}

  public async connect(userId: string, afterId: bigint, stream: RealtimeStream): Promise<void> {
    this.assertAcceptingConnections();

    const connectionCount =
      [...this.sessions.values()].filter((session) => session.userId === userId && !session.closed)
        .length + (this.pendingConnectionsByUser.get(userId) ?? 0);
    if (connectionCount >= this.configuration.maxConnectionsPerUser) {
      throw new AppError(429, 'SSE_CONNECTION_LIMIT', 'Too many live connections');
    }

    this.pendingConnectionsByUser.set(userId, (this.pendingConnectionsByUser.get(userId) ?? 0) + 1);

    let initialEvents: RealtimeEvent[];
    try {
      if (!(await this.repository.isActiveUser(userId))) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
      }
      initialEvents = await this.repository.findVisibleAfter(
        userId,
        afterId,
        this.configuration.replayBatchSize,
      );
      this.assertAcceptingConnections();
    } finally {
      const remaining = (this.pendingConnectionsByUser.get(userId) ?? 1) - 1;
      if (remaining === 0) this.pendingConnectionsByUser.delete(userId);
      else this.pendingConnectionsByUser.set(userId, remaining);
    }

    const session: Session = {
      key: Symbol(userId),
      userId,
      cursor: afterId,
      stream,
      openedAt: Date.now(),
      timer: undefined,
      draining: false,
      drainAgain: false,
      closed: false,
    };

    stream.onClose(() => {
      this.removeSession(session);
    });
    stream.open(this.configuration.retryMs);
    this.sessions.set(session.key, session);

    if (!this.sendEvents(session, initialEvents)) return;

    session.timer = setInterval(() => {
      void this.onHeartbeat(session);
    }, this.configuration.heartbeatIntervalMs);
    session.timer.unref();

    // Closes the small race between the initial query and session registration.
    void this.drain(session);
  }

  public wakeAll(): void {
    for (const session of this.sessions.values()) void this.drain(session);
  }

  public shutdown(): void {
    this.acceptingConnections = false;
    for (const session of [...this.sessions.values()]) {
      session.stream.send({
        event: 'stream.closed',
        data: { reason: 'server_shutdown' },
      });
      this.removeSession(session);
    }
  }

  private sendEvents(session: Session, events: RealtimeEvent[]): boolean {
    if (this.isSessionClosed(session)) return false;

    for (const event of events) {
      const writable = session.stream.send({
        id: event.id,
        event: event.type,
        data: event.data,
      });
      if (!writable) {
        this.logger.warn({ userId: session.userId }, 'Closing backpressured SSE connection');
        this.removeSession(session);
        return false;
      }
      session.cursor = BigInt(event.id);
    }
    return true;
  }

  private async drain(session: Session): Promise<void> {
    if (session.closed) return;
    if (session.draining) {
      session.drainAgain = true;
      return;
    }

    session.draining = true;
    try {
      do {
        session.drainAgain = false;
        let events: RealtimeEvent[];
        do {
          events = await this.repository.findVisibleAfter(
            session.userId,
            session.cursor,
            this.configuration.replayBatchSize,
          );
          if (!this.sendEvents(session, events)) return;
        } while (
          events.length === this.configuration.replayBatchSize &&
          !this.isSessionClosed(session)
        );
      } while (this.shouldDrainAgain(session) && !this.isSessionClosed(session));
    } catch (error) {
      this.logger.warn(
        { err: error, userId: session.userId },
        'SSE catch-up failed; the next heartbeat will retry',
      );
    } finally {
      session.draining = false;
    }
  }

  private async onHeartbeat(session: Session): Promise<void> {
    if (session.closed) return;

    if (Date.now() - session.openedAt >= this.configuration.maxConnectionDurationMs) {
      session.stream.send({
        event: 'stream.refresh-required',
        data: { reason: 'connection_age_limit' },
      });
      this.removeSession(session);
      return;
    }

    try {
      if (!(await this.repository.isActiveUser(session.userId))) {
        session.stream.send({
          event: 'stream.closed',
          data: { reason: 'authorization_revoked' },
        });
        this.removeSession(session);
        return;
      }
    } catch (error) {
      this.logger.warn({ err: error, userId: session.userId }, 'SSE authorization recheck failed');
      this.removeSession(session);
      return;
    }

    if (!session.stream.heartbeat()) {
      this.removeSession(session);
      return;
    }
    await this.drain(session);
  }

  private removeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    if (session.timer !== undefined) clearInterval(session.timer);
    this.sessions.delete(session.key);
    session.stream.close();
  }

  private assertAcceptingConnections(): void {
    if (!this.acceptingConnections) {
      throw new AppError(503, 'SERVER_DRAINING', 'The server is shutting down');
    }
  }

  private isSessionClosed(session: Session): boolean {
    return session.closed;
  }

  private shouldDrainAgain(session: Session): boolean {
    return session.drainAgain;
  }
}
