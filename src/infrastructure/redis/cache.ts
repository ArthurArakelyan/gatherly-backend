import type { Logger } from 'pino';
import type { ZodType } from 'zod';

import type { GatherlyRedisClient } from './client.js';

export class RedisCache {
  public constructor(
    private readonly client: GatherlyRedisClient,
    private readonly logger: Logger,
  ) {}

  public async get<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    if (!this.client.isReady) return null;

    try {
      const value = await this.client.get(key);
      if (value === null) return null;

      const parsedJson: unknown = JSON.parse(value);
      const parsed = schema.safeParse(parsedJson);
      if (!parsed.success) {
        this.logger.warn('Discarding invalid cached JSON value');
        await this.client.del(key);
        return null;
      }

      return parsed.data;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis cache read failed');
      if (error instanceof SyntaxError) await this.delete(key);
      return null;
    }
  }

  public async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client.isReady) return;

    try {
      const serialized: unknown = JSON.stringify(value);
      if (typeof serialized !== 'string') {
        this.logger.warn('Redis cache value could not be serialized');
        return;
      }

      await this.client.set(key, serialized, { EX: ttlSeconds });
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis cache write failed');
    }
  }

  public async delete(key: string): Promise<void> {
    if (!this.client.isReady) return;

    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis cache deletion failed');
    }
  }
}
