import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { environment } from '../../config/env.js';
import { createPool } from './pool.js';

const seedFile = path.resolve(process.cwd(), 'db/seeds/development.sql');

const seed = async (): Promise<void> => {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Development seeds must not run with NODE_ENV=production');
  }

  const sql = await readFile(seedFile, 'utf8');
  const pool = createPool(environment);

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.info('Development seed applied');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

try {
  await seed();
} catch (error) {
  console.error('Database seed failed', error);
  process.exitCode = 1;
}
