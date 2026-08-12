import { createHash, randomBytes } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../modules/identity/identity.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { GatherlyRedisClient } from './client.js';

const ticketValueSchema = z.strictObject({
  userId: z.uuid(),
  username: z.string().min(1),
  issuedAt: z.iso.datetime(),
});

export interface ConsumedWebSocketTicket {
  userId: string;
  username: string;
}

const digest = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

export class WebSocketTicketStore {
  public constructor(
    private readonly redis: GatherlyRedisClient,
    private readonly logger: Logger,
    private readonly ttlSeconds: number,
  ) {}

  public async issue(user: AuthenticatedUser): Promise<{ ticket: string; expiresIn: number }> {
    if (!this.redis.isReady) {
      throw new AppError(503, 'CHAT_HANDSHAKE_UNAVAILABLE', 'Chat handshake is unavailable');
    }

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ticket = randomBytes(32).toString('base64url');
        const stored = await this.redis.set(
          `gatherly:v1:websocket-ticket:${digest(ticket)}`,
          JSON.stringify({
            userId: user.id,
            username: user.username,
            issuedAt: new Date().toISOString(),
          }),
          { EX: this.ttlSeconds, NX: true },
        );
        if (stored === 'OK') return { ticket, expiresIn: this.ttlSeconds };
      }
      throw new Error('Could not allocate a unique WebSocket ticket');
    } catch (error) {
      this.logger.warn({ err: error }, 'WebSocket ticket creation failed');
      throw new AppError(503, 'CHAT_HANDSHAKE_UNAVAILABLE', 'Chat handshake is unavailable');
    }
  }

  public async consume(ticket: string): Promise<ConsumedWebSocketTicket | null> {
    if (!this.redis.isReady) return null;

    try {
      const value = await this.redis.getDel(`gatherly:v1:websocket-ticket:${digest(ticket)}`);
      if (value === null) return null;
      const parsedJson: unknown = JSON.parse(value);
      const parsed = ticketValueSchema.safeParse(parsedJson);
      if (!parsed.success) return null;
      return { userId: parsed.data.userId, username: parsed.data.username };
    } catch (error) {
      this.logger.warn({ err: error }, 'WebSocket ticket consumption failed');
      return null;
    }
  }
}
