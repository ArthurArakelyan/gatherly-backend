import type { Pool } from 'pg';

import { withPostgresAdvisoryLock } from '../infrastructure/postgres/advisory-lock.js';
import type { SearchReconciliationLock } from './search-reconciliation-job.js';
import { SEARCH_RECONCILIATION_LOCK_NAME } from './search-reconciliation-job.js';

export const createSearchReconciliationLock =
  (pool: Pool): SearchReconciliationLock =>
  async (operation) => {
    const client = await pool.connect();
    try {
      return await withPostgresAdvisoryLock(client, SEARCH_RECONCILIATION_LOCK_NAME, operation);
    } finally {
      client.release();
    }
  };
