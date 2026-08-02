import pg from 'pg';

import type { Environment } from '../../config/env.js';

const { Pool } = pg;

export const createPool = (environment: Environment): pg.Pool => {
  const pool = new Pool({
    host: environment.PGHOST,
    port: environment.PGPORT,
    database: environment.PGDATABASE,
    user: environment.PGUSER,
    password: environment.PGPASSWORD,
    max: environment.PGPOOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  return pool;
};
