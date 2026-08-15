import 'dotenv/config';

import { Client as PostgresClient } from 'pg';

import { parseSearchReindexEnvironment } from '../config/search-reindex-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { withPostgresAdvisoryLock } from '../infrastructure/postgres/advisory-lock.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import { SearchReconciler } from '../modules/search/search-reconciler.js';
import { createLogger } from '../shared/logging/logger.js';

const logger = createLogger();
const environment = parseSearchReindexEnvironment(process.env);
const metrics = createApplicationMetrics();
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const lockClient = new PostgresClient({ connectionString: environment.DATABASE_URL });

try {
  await lockClient.connect();
  const reconciler = new SearchReconciler(new EventSearchSourceRepository(prisma), elasticsearch);
  const outcome = await withPostgresAdvisoryLock(lockClient, 'gatherly:search-reconciliation', () =>
    reconciler.reconcile(),
  );

  if (!outcome.acquired) {
    logger.info('Search reconciliation skipped because another run owns the lock');
  } else {
    const result = outcome.value;
    metrics.reconciliationDrift.set({ kind: 'missing' }, result.missing);
    metrics.reconciliationDrift.set({ kind: 'stale' }, result.stale);
    metrics.reconciliationDrift.set({ kind: 'ineligible' }, result.ineligible);
    logger.info(result, 'Search reconciliation completed');
    if (result.missing + result.stale + result.ineligible > 0) process.exitCode = 2;
  }
} catch (error) {
  logger.error({ err: error }, 'Search reconciliation failed');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    lockClient.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
}
