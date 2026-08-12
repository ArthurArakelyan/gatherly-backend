import type { Logger } from 'pino';

import type { ChatPresence } from '../../modules/chat/chat.types.js';
import type { GatherlyRedisClient } from './client.js';

const member = (userId: string, connectionId: string): string => `${userId}.${connectionId}`;
const userIdFromMember = (value: string): string => value.slice(0, 36);

export class RedisChatPresence implements ChatPresence {
  private readonly local = new Map<string, Map<string, string>>();

  public constructor(
    private readonly redis: GatherlyRedisClient,
    private readonly logger: Logger,
    private readonly leaseMs: number,
  ) {}

  public async join(eventId: string, userId: string, connectionId: string): Promise<string[]> {
    let localEvent = this.local.get(eventId);
    if (localEvent === undefined) {
      localEvent = new Map();
      this.local.set(eventId, localEvent);
    }
    localEvent.set(connectionId, userId);
    await this.writeLease(eventId, userId, connectionId);
    return this.snapshot(eventId);
  }

  public renew(eventId: string, userId: string, connectionId: string): Promise<void> {
    return this.writeLease(eventId, userId, connectionId);
  }

  public async leave(eventId: string, userId: string, connectionId: string): Promise<boolean> {
    const localEvent = this.local.get(eventId);
    localEvent?.delete(connectionId);
    if (localEvent?.size === 0) this.local.delete(eventId);

    if (this.redis.isReady) {
      try {
        await this.redis.zRem(this.key(eventId), member(userId, connectionId));
      } catch (error) {
        this.logger.warn({ err: error }, 'Chat presence removal failed');
      }
    }
    return (await this.snapshot(eventId)).includes(userId);
  }

  private async writeLease(eventId: string, userId: string, connectionId: string): Promise<void> {
    if (!this.redis.isReady) return;

    try {
      const key = this.key(eventId);
      await this.redis.zAdd(key, [
        { score: Date.now() + this.leaseMs, value: member(userId, connectionId) },
      ]);
      await this.redis.expire(key, Math.ceil(this.leaseMs / 1_000) * 2);
    } catch (error) {
      this.logger.warn({ err: error }, 'Chat presence lease update failed');
    }
  }

  private async snapshot(eventId: string): Promise<string[]> {
    const userIds = new Set(this.local.get(eventId)?.values() ?? []);
    if (!this.redis.isReady) return [...userIds].sort();

    try {
      const key = this.key(eventId);
      const now = Date.now();
      await this.redis.zRemRangeByScore(key, 0, now);
      const active = await this.redis.zRangeByScore(key, now + 1, '+inf');
      for (const value of active) userIds.add(userIdFromMember(value));
    } catch (error) {
      this.logger.warn({ err: error }, 'Chat presence snapshot failed');
    }
    return [...userIds].sort();
  }

  private key(eventId: string): string {
    return `gatherly:v1:chat:presence:${eventId}`;
  }
}
