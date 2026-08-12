import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import WebSocket, { type RawData } from 'ws';

import type { ChatService } from '../../modules/chat/chat.service.js';
import { clientChatCommandSchema } from '../../modules/chat/chat.schemas.js';
import type {
  ChatPresence,
  ChatSignal,
  ChatSignalPublisher,
  ChatSignalTarget,
  ClientChatCommand,
  ServerChatEvent,
} from '../../modules/chat/chat.types.js';
import { AppError } from '../../shared/errors/app-error.js';

interface GatewayConfiguration {
  heartbeatIntervalMs: number;
  maxConnectionDurationMs: number;
  maxBufferedBytes: number;
  commandLimit: number;
  commandWindowMs: number;
  typingTtlMs: number;
}

interface ChatSession {
  id: string;
  socket: WebSocket;
  userId: string;
  username: string;
  eventId: string | null;
  openedAt: number;
  alive: boolean;
  closed: boolean;
  heartbeatRunning: boolean;
  commandTimes: number[];
  queue: Promise<void>;
  typingTimer: NodeJS.Timeout | undefined;
}

const asText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
};

export class ChatWebSocketGateway implements ChatSignalTarget {
  private readonly sessions = new Map<string, ChatSession>();
  private acceptingConnections = true;
  private readonly heartbeatTimer: NodeJS.Timeout;

  public constructor(
    private readonly service: ChatService,
    private readonly signals: ChatSignalPublisher,
    private readonly presence: ChatPresence,
    private readonly logger: Logger,
    private readonly configuration: GatewayConfiguration,
  ) {
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.sessions.values()) void this.heartbeat(session);
    }, configuration.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  public accept(socket: WebSocket, user: { userId: string; username: string }): void {
    if (!this.acceptingConnections) {
      socket.close(1013, 'server_draining');
      return;
    }

    const session: ChatSession = {
      id: randomUUID(),
      socket,
      userId: user.userId,
      username: user.username,
      eventId: null,
      openedAt: Date.now(),
      alive: true,
      closed: false,
      heartbeatRunning: false,
      commandTimes: [],
      queue: Promise.resolve(),
      typingTimer: undefined,
    };
    this.sessions.set(session.id, session);

    socket.on('pong', () => {
      session.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text_frames_only');
        return;
      }
      session.queue = session.queue
        .then(() => this.onMessage(session, asText(data)))
        .catch((error: unknown) => {
          this.logger.error({ err: error, userId: session.userId }, 'Chat command queue failed');
          this.closeSession(session, 1011, 'internal_error');
        });
    });
    socket.once('close', () => {
      void this.cleanup(session);
    });
    socket.on('error', (error) => {
      this.logger.warn({ err: error, userId: session.userId }, 'Chat WebSocket error');
    });

    this.send(session, { type: 'connection.ready', data: { protocol: 'gatherly.chat.v1' } });
  }

  public async handleSignal(signal: ChatSignal): Promise<void> {
    if (signal.kind === 'message.created' || signal.kind === 'message.deleted') {
      const message = await this.service.findMessageForBroadcast(signal.eventId, signal.messageId);
      if (message === null) return;
      const type = message.deletedAt === null ? 'chat.message.created' : 'chat.message.deleted';
      await this.broadcastAuthorized(signal.eventId, { type, data: { message } });
      return;
    }

    if (signal.kind === 'typing.updated') {
      await this.broadcastAuthorized(signal.eventId, {
        type: 'chat.typing.updated',
        data: {
          eventId: signal.eventId,
          userId: signal.userId,
          username: signal.username,
          isTyping: signal.isTyping,
        },
      });
      return;
    }

    await this.broadcastAuthorized(signal.eventId, {
      type: 'chat.presence.updated',
      data: {
        eventId: signal.eventId,
        userId: signal.userId,
        username: signal.username,
        online: signal.online,
      },
    });
  }

  public async shutdown(): Promise<void> {
    if (!this.acceptingConnections) return;
    this.acceptingConnections = false;
    clearInterval(this.heartbeatTimer);

    await Promise.all([...this.sessions.values()].map((session) => this.leaveRoom(session)));
    for (const session of this.sessions.values())
      this.closeSession(session, 1001, 'server_shutdown');
  }

  private async onMessage(session: ChatSession, text: string): Promise<void> {
    if (session.closed) return;
    if (!this.consumeCommandQuota(session)) {
      this.sendError(session, undefined, 'CHAT_RATE_LIMITED', 'Too many chat commands');
      this.closeSession(session, 1008, 'rate_limited');
      return;
    }

    let command: ClientChatCommand;
    try {
      const parsedJson: unknown = JSON.parse(text);
      command = clientChatCommandSchema.parse(parsedJson);
    } catch {
      this.sendError(session, undefined, 'INVALID_CHAT_FRAME', 'Chat frame is invalid');
      return;
    }

    try {
      await this.execute(session, command);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(session, command.requestId, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  private async execute(session: ChatSession, command: ClientChatCommand): Promise<void> {
    if (command.type === 'chat.join') {
      const access = await this.service.requireAccess(command.eventId, session.userId);
      if (session.eventId !== null && session.eventId !== command.eventId) {
        await this.leaveRoom(session);
      }
      session.eventId = command.eventId;
      const onlineUserIds = await this.presence.join(command.eventId, session.userId, session.id);
      this.send(session, {
        type: 'chat.joined',
        requestId: command.requestId,
        data: { eventId: command.eventId },
      });
      this.send(session, {
        type: 'chat.presence.snapshot',
        data: { eventId: command.eventId, onlineUserIds },
      });
      this.signals.publish({
        kind: 'presence.updated',
        eventId: command.eventId,
        userId: access.userId,
        username: access.username,
        online: true,
      });
      return;
    }

    if (command.type === 'chat.leave') {
      const eventId = session.eventId;
      await this.leaveRoom(session);
      this.send(session, { type: 'chat.left', requestId: command.requestId, data: { eventId } });
      return;
    }

    this.assertJoined(session, command.eventId);

    if (command.type === 'chat.message.send') {
      const result = await this.service.sendMessage(
        command.eventId,
        session.userId,
        command.clientMessageId,
        command.body,
      );
      this.send(session, {
        type: 'chat.message.accepted',
        requestId: command.requestId,
        data: {
          messageId: result.message.id,
          clientMessageId: command.clientMessageId,
          duplicate: result.duplicate,
        },
      });
      if (!result.duplicate) {
        this.signals.publish({
          kind: 'message.created',
          eventId: command.eventId,
          messageId: result.message.id,
        });
      }
      return;
    }

    if (command.type === 'chat.message.delete') {
      const result = await this.service.deleteMessage(
        command.eventId,
        command.messageId,
        session.userId,
      );
      this.send(session, {
        type: 'chat.message.deleted.accepted',
        requestId: command.requestId,
        data: { messageId: result.message.id },
      });
      if (result.changed) {
        this.signals.publish({
          kind: 'message.deleted',
          eventId: command.eventId,
          messageId: result.message.id,
        });
      }
      return;
    }

    await this.service.requireAccess(command.eventId, session.userId);
    this.setTyping(session, command.isTyping);
  }

  private setTyping(session: ChatSession, isTyping: boolean): void {
    if (session.eventId === null) return;
    if (session.typingTimer !== undefined) clearTimeout(session.typingTimer);
    session.typingTimer = undefined;
    this.publishTyping(session, isTyping);

    if (isTyping) {
      session.typingTimer = setTimeout(() => {
        session.typingTimer = undefined;
        this.publishTyping(session, false);
      }, this.configuration.typingTtlMs);
      session.typingTimer.unref();
    }
  }

  private publishTyping(session: ChatSession, isTyping: boolean): void {
    if (session.eventId === null) return;
    this.signals.publish({
      kind: 'typing.updated',
      eventId: session.eventId,
      userId: session.userId,
      username: session.username,
      isTyping,
    });
  }

  private async leaveRoom(session: ChatSession): Promise<void> {
    const eventId = session.eventId;
    if (eventId === null) return;
    if (session.typingTimer !== undefined) clearTimeout(session.typingTimer);
    session.typingTimer = undefined;
    this.publishTyping(session, false);
    session.eventId = null;

    const stillOnline = await this.presence.leave(eventId, session.userId, session.id);
    this.signals.publish({
      kind: 'presence.updated',
      eventId,
      userId: session.userId,
      username: session.username,
      online: stillOnline,
    });
  }

  private async heartbeat(session: ChatSession): Promise<void> {
    if (session.closed || session.heartbeatRunning) return;
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.heartbeatRunning = true;
    try {
      if (!session.alive) {
        session.socket.terminate();
        return;
      }
      if (Date.now() - session.openedAt >= this.configuration.maxConnectionDurationMs) {
        this.send(session, {
          type: 'connection.refresh',
          data: { reason: 'connection_age_limit' },
        });
        this.closeSession(session, 4001, 'refresh_required');
        return;
      }

      session.alive = false;
      session.socket.ping();
      if (session.eventId !== null) {
        try {
          await this.service.requireAccess(session.eventId, session.userId);
          await this.presence.renew(session.eventId, session.userId, session.id);
        } catch {
          await this.leaveRoom(session);
          this.closeSession(session, 4003, 'authorization_revoked');
        }
      }
    } finally {
      session.heartbeatRunning = false;
    }
  }

  private async broadcastAuthorized(eventId: string, event: ServerChatEvent): Promise<void> {
    const recipients = [...this.sessions.values()].filter(
      (session) => !session.closed && session.eventId === eventId,
    );
    await Promise.all(
      recipients.map(async (session) => {
        try {
          await this.service.requireAccess(eventId, session.userId);
          this.send(session, event);
        } catch {
          await this.leaveRoom(session);
          this.closeSession(session, 4003, 'authorization_revoked');
        }
      }),
    );
  }

  private consumeCommandQuota(session: ChatSession): boolean {
    const cutoff = Date.now() - this.configuration.commandWindowMs;
    session.commandTimes = session.commandTimes.filter((timestamp) => timestamp > cutoff);
    if (session.commandTimes.length >= this.configuration.commandLimit) return false;
    session.commandTimes.push(Date.now());
    return true;
  }

  private assertJoined(session: ChatSession, eventId: string): void {
    if (session.eventId !== eventId) {
      throw new AppError(409, 'CHAT_NOT_JOINED', 'Join this event chat first');
    }
  }

  private send(session: ChatSession, event: ServerChatEvent): boolean {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return false;
    if (session.socket.bufferedAmount > this.configuration.maxBufferedBytes) {
      this.closeSession(session, 1013, 'backpressure');
      return false;
    }
    session.socket.send(JSON.stringify(event), (error) => {
      if (error) {
        this.logger.warn({ err: error, userId: session.userId }, 'Chat frame send failed');
        this.closeSession(session, 1011, 'send_failed');
      }
    });
    return true;
  }

  private sendError(
    session: ChatSession,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    this.send(session, {
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      error: { code, message },
    });
  }

  private closeSession(session: ChatSession, code: number, reason: string): void {
    if (session.closed || session.socket.readyState >= WebSocket.CLOSING) return;
    session.socket.close(code, reason);
  }

  private async cleanup(session: ChatSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    await this.leaveRoom(session);
  }
}
