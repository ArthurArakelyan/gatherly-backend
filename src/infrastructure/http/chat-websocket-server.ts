import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';

import type { ChatService } from '../../modules/chat/chat.service.js';
import type { WebSocketTicketStore } from '../redis/websocket-ticket-store.js';
import type { ChatWebSocketGateway } from './chat-websocket-gateway.js';

const protocol = 'gatherly.chat.v1';
const ticketPrefix = 'gatherly.ticket.';
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;

interface ChatWebSocketServerConfiguration {
  allowedOrigin: string;
  maxPayloadBytes: number;
}

const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
};

const readTicket = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const offered = header.split(',').map((value) => value.trim());
  if (offered.length !== 2 || !offered.includes(protocol)) return null;
  const ticketProtocol = offered.find((value) => value.startsWith(ticketPrefix));
  if (ticketProtocol === undefined) return null;
  const ticket = ticketProtocol.slice(ticketPrefix.length);
  return ticketPattern.test(ticket) ? ticket : null;
};

export class ChatWebSocketServer {
  private readonly webSocketServer: WebSocketServer;
  private started = false;

  public constructor(
    private readonly server: Server,
    private readonly tickets: WebSocketTicketStore,
    private readonly chatService: ChatService,
    private readonly gateway: ChatWebSocketGateway,
    private readonly logger: Logger,
    private readonly configuration: ChatWebSocketServerConfiguration,
  ) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      perMessageDeflate: false,
      maxPayload: configuration.maxPayloadBytes,
      handleProtocols: (protocols) => (protocols.has(protocol) ? protocol : false),
    });
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.server.on('upgrade', this.handleUpgrade);
  }

  public async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.server.off('upgrade', this.handleUpgrade);
    await this.gateway.shutdown();

    const forceTimer = setTimeout(() => {
      for (const client of this.webSocketServer.clients) client.terminate();
    }, 1_000);
    forceTimer.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        this.webSocketServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    } finally {
      clearTimeout(forceTimer);
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? '/', 'http://gatherly.local').pathname;
    if (pathname !== '/api/chat/socket') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!this.started) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (request.headers.origin !== this.configuration.allowedOrigin) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const ticket = readTicket(request.headers['sec-websocket-protocol']);
    if (ticket === null) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const onSocketError = (error: Error): void => {
      this.logger.warn({ err: error }, 'WebSocket upgrade socket failed');
    };
    socket.once('error', onSocketError);

    void this.tickets
      .consume(ticket)
      .then(async (consumed) => {
        if (consumed === null) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const currentUser = await this.chatService.requireActiveUser(consumed.userId);
        if (socket.destroyed) return;
        if (!this.started) {
          rejectUpgrade(socket, 503, 'Service Unavailable');
          return;
        }

        socket.removeListener('error', onSocketError);
        this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          this.gateway.accept(webSocket, currentUser);
        });
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'WebSocket upgrade authentication failed');
        rejectUpgrade(socket, 401, 'Unauthorized');
      });
  };
}
