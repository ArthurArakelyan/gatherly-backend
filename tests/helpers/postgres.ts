import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg, { type Pool } from 'pg';

import { runMigrations } from '../../src/infrastructure/postgres/migration-runner.js';

export interface PostgresHarness {
  pool: Pool;
  reset: () => Promise<void>;
  seed: () => Promise<void>;
  stop: () => Promise<void>;
}

const migrationsDirectory = path.resolve(process.cwd(), 'db/migrations');
const developmentSeedFile = path.resolve(process.cwd(), 'db/seeds/development.sql');

export const startPostgresHarness = async (): Promise<PostgresHarness> => {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-bookworm',
  ).start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });

  await runMigrations(pool, migrationsDirectory);

  return {
    pool,
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
      await pool.end();
      await container.stop();
    },
  };
};
