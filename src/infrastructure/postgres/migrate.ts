import 'dotenv/config';

import path from 'node:path';

import { environment } from '../../config/env.js';
import { runMigrations } from './migration-runner.js';
import { createPool } from './pool.js';

const migrationsDirectory = path.resolve(process.cwd(), 'db/migrations');

const migrate = async (): Promise<void> => {
  const pool = createPool(environment);

  try {
    await runMigrations(pool, migrationsDirectory);
    console.info('Database migrations are up to date');
  } finally {
    await pool.end();
  }
};

try {
  await migrate();
} catch (error) {
  console.error('Database migration failed', error);
  process.exitCode = 1;
}
