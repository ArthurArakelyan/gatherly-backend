import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pino from 'pino';

import {
  closeRedisClient,
  createRedisClient,
  type GatherlyRedisClient,
} from '../../src/infrastructure/redis/client.js';

export interface RedisHarness {
  client: GatherlyRedisClient;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export const startRedisHarness = async (): Promise<RedisHarness> => {
  const container: StartedRedisContainer = await new RedisContainer('redis:8.2-bookworm').start();
  const client = createRedisClient(
    {
      REDIS_URL: container.getConnectionUrl(),
      REDIS_CONNECT_TIMEOUT_MS: 1_000,
    },
    pino({ enabled: false }),
  );
  await client.connect();

  return {
    client,
    reset: async () => {
      await client.configSet('maxmemory', '0');
      await client.configSet('maxmemory-policy', 'noeviction');
      await client.flushDb();
    },
    stop: async () => {
      await closeRedisClient(client);
      await container.stop();
    },
  };
};
