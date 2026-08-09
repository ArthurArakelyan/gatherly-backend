import { createHash } from 'node:crypto';

import type { Logger } from 'pino';

import type {
  FixedWindowRateLimiter,
  FixedWindowResult,
} from '../../shared/rate-limit/fixed-window-rate-limiter.js';
import type { GatherlyRedisClient } from './client.js';

const consumeScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

const hashSubject = (subject: string): string => createHash('sha256').update(subject).digest('hex');

export class RedisFixedWindowRateLimiter implements FixedWindowRateLimiter {
  public constructor(
    private readonly client: GatherlyRedisClient,
    private readonly logger: Logger,
  ) {}

  public async consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<FixedWindowResult | null> {
    if (!this.client.isReady) return null;

    const key = `gatherly:v1:rate:${scope}:${hashSubject(subject)}`;
    try {
      const reply: unknown = await this.client.eval(consumeScript, {
        keys: [key],
        arguments: [windowSeconds.toString()],
      });
      if (!Array.isArray(reply) || reply.length !== 2) {
        throw new Error('Unexpected Redis limiter reply');
      }

      const count = Number(reply[0]);
      const ttl = Number(reply[1]);
      if (!Number.isInteger(count) || !Number.isInteger(ttl) || ttl < 0) {
        throw new Error('Invalid Redis limiter reply');
      }

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAfterSeconds: ttl,
      };
    } catch (error) {
      this.logger.warn({ err: error, scope }, 'Redis rate limiter failed');
      return null;
    }
  }
}
