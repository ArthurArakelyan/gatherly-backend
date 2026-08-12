import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import WebSocket from 'ws';

import { ChatWebSocketGateway } from '../../src/infrastructure/http/chat-websocket-gateway.js';
import { ChatWebSocketServer } from '../../src/infrastructure/http/chat-websocket-server.js';
import { RedisChatBus, createChatSubscriber } from '../../src/infrastructure/redis/chat-bus.js';
import { RedisChatPresence } from '../../src/infrastructure/redis/chat-presence.js';
import { WebSocketTicketStore } from '../../src/infrastructure/redis/websocket-ticket-store.js';
import { ChatRepository } from '../../src/modules/chat/chat.repository.js';
import { ChatService } from '../../src/modules/chat/chat.service.js';
import type { ServerChatEvent } from '../../src/modules/chat/chat.types.js';
import type { PostgresHarness } from './postgres.js';
import type { RedisHarness } from './redis.js';
import { createTestApp } from './test-app.js';

const logger = pino({ enabled: false });
export const chatOrigin = 'http://localhost:5173';
export const chatProtocol = 'gatherly.chat.v1';

interface ChatHarnessConfiguration {
  heartbeatIntervalMs?: number;
  maxConnectionDurationMs?: number;
  maxPayloadBytes?: number;
}

export interface ChatWebSocketHarness {
  baseUrl: string;
  repository: ChatRepository;
  service: ChatService;
  tickets: WebSocketTicketStore;
  stop: () => Promise<void>;
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
};

export const startChatWebSocketHarness = async (
  postgres: PostgresHarness,
  redis: RedisHarness,
  configuration: ChatHarnessConfiguration = {},
): Promise<ChatWebSocketHarness> => {
  const repository = new ChatRepository(postgres.pool);
  const service = new ChatService(repository);
  const tickets = new WebSocketTicketStore(redis.client, logger, 30);
  const app = createTestApp(postgres, { chatTicketStore: tickets });
  const server = createServer(app);
  const bus = new RedisChatBus(redis.client, createChatSubscriber(redis.client, logger), logger);
  const gateway = new ChatWebSocketGateway(
    service,
    bus,
    new RedisChatPresence(redis.client, logger, 200),
    logger,
    {
      heartbeatIntervalMs: configuration.heartbeatIntervalMs ?? 1_000,
      maxConnectionDurationMs: configuration.maxConnectionDurationMs ?? 60_000,
      maxBufferedBytes: 64 * 1024,
      commandLimit: 100,
      commandWindowMs: 1_000,
      typingTtlMs: 100,
    },
  );
  const socketServer = new ChatWebSocketServer(server, tickets, service, gateway, logger, {
    allowedOrigin: chatOrigin,
    maxPayloadBytes: configuration.maxPayloadBytes ?? 4_096,
  });
  bus.start(gateway);
  socketServer.start();
  const port = await listen(server);

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    repository,
    service,
    tickets,
    stop: async () => {
      await socketServer.shutdown();
      await closeHttpServer(server);
      await bus.close();
    },
  };
};

export interface ConnectedChatSocket {
  socket: WebSocket;
  next: (type?: ServerChatEvent['type']) => Promise<ServerChatEvent>;
}

const rawDataText = (data: WebSocket.RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
};

export const connectChatSocket = async (
  baseUrl: string,
  ticket: string,
  options: { origin?: string; path?: string; protocols?: string[] } = {},
): Promise<ConnectedChatSocket> => {
  const queue: ServerChatEvent[] = [];
  const receivedTypes: ServerChatEvent['type'][] = [];
  const waiters: ((event: ServerChatEvent) => void)[] = [];
  let closeSummary = 'open';
  const socket = new WebSocket(
    `${baseUrl.replace('http:', 'ws:')}${options.path ?? '/api/chat/socket'}`,
    options.protocols ?? [chatProtocol, `gatherly.ticket.${ticket}`],
    { origin: options.origin ?? chatOrigin },
  );
  socket.on('message', (data) => {
    const event = JSON.parse(rawDataText(data)) as ServerChatEvent;
    receivedTypes.push(event.type);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(event);
    else waiter(event);
  });
  socket.on('close', (code, reason) => {
    closeSummary = `${String(code)}:${reason.toString()}`;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    socket,
    next: async (type) => {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const event =
          queue.shift() ??
          (await new Promise<ServerChatEvent>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(
                new Error(
                  `Timed out waiting for chat frame; readyState=${String(socket.readyState)} close=${closeSummary} received=${receivedTypes.join(',')}`,
                ),
              );
            }, 2_000);
            timer.unref();
            waiters.push((value) => {
              clearTimeout(timer);
              resolve(value);
            });
          }));
        if (type === undefined || event.type === type) return event;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${type}`);
      }
    },
  };
};

export const rejectedUpgradeStatus = async (
  baseUrl: string,
  options: { ticket?: string; origin?: string; path?: string; protocols?: string[] },
): Promise<number> => {
  const protocols =
    options.protocols ??
    (options.ticket === undefined
      ? [chatProtocol]
      : [chatProtocol, `gatherly.ticket.${options.ticket}`]);
  const socket = new WebSocket(
    `${baseUrl.replace('http:', 'ws:')}${options.path ?? '/api/chat/socket'}`,
    protocols,
    { origin: options.origin ?? chatOrigin },
  );
  return new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('WebSocket unexpectedly upgraded'));
    });
    socket.once('error', () => undefined);
  });
};
