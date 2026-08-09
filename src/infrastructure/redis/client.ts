import type { Logger } from 'pino';
import { createClient, type RedisClientType } from 'redis';

export type GatherlyRedisClient = RedisClientType;

interface RedisClientConfiguration {
  REDIS_URL: string;
  REDIS_CONNECT_TIMEOUT_MS: number;
}

export const createRedisClient = (
  configuration: RedisClientConfiguration,
  logger: Logger,
): GatherlyRedisClient => {
  const client = createClient({
    url: configuration.REDIS_URL,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: configuration.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 3_000),
    },
  });

  client.on('error', (error) => {
    logger.warn({ err: error }, 'Redis client error; disposable features are degraded');
  });
  client.on('ready', () => {
    logger.info('Redis client ready');
  });
  client.on('reconnecting', () => {
    logger.warn('Redis client reconnecting');
  });

  return client;
};

export const startRedisClient = (client: GatherlyRedisClient, logger: Logger): void => {
  void client.connect().catch((error: unknown) => {
    logger.warn({ err: error }, 'Initial Redis connection failed; continuing without Redis');
  });
};

export const closeRedisClient = async (client: GatherlyRedisClient): Promise<void> => {
  if (client.isOpen) await client.close();
};
