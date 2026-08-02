import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Pool } from 'pg';

const migrationLockKey = '314159265358979';

export const runMigrations = async (pool: Pool, migrationsDirectory: string): Promise<void> => {
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [migrationLockKey]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const history = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const appliedNames = new Set(history.rows.map((row) => row.name));

    for (const name of migrationNames) {
      if (appliedNames.has(name)) continue;

      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        console.info(`Applied migration: ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLockKey]);
      }
    } finally {
      client.release();
    }
  }
};
