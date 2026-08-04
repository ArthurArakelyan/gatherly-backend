import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg, { type Pool } from 'pg';

import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createPrismaClient } from '../../src/infrastructure/prisma/client.js';
import { deployPrismaMigrations } from './prisma-migrate.js';

export interface PostgresHarness {
  connectionString: string;
  pool: Pool;
  prisma: PrismaClient;
  reset: () => Promise<void>;
  seed: () => Promise<void>;
  stop: () => Promise<void>;
}

const developmentSeedFile = path.resolve(process.cwd(), 'db/seeds/development.sql');

export const startPostgresHarness = async (): Promise<PostgresHarness> => {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-bookworm',
  ).start();
  const connectionString = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString, max: 10 });

  await deployPrismaMigrations(connectionString);
  const prisma = createPrismaClient({ DATABASE_URL: connectionString, PRISMA_POOL_MAX: 5 });

  return {
    connectionString,
    pool,
    prisma,
    reset: async () => {
      await pool.query(`
        TRUNCATE TABLE
          notifications,
          idempotency_keys,
          waitlist_entries,
          reservations,
          events,
          community_memberships,
          communities,
          users
        RESTART IDENTITY CASCADE
      `);
    },
    seed: async () => {
      const sql = await readFile(developmentSeedFile, 'utf8');
      await pool.query(sql);
    },
    stop: async () => {
      await Promise.all([prisma.$disconnect(), pool.end()]);
      await container.stop();
    },
  };
};
