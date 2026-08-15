import type { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import pg, { type Pool } from 'pg';
import type { Logger } from 'pino';

import type { SearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import type { ApplicationMetrics } from '../infrastructure/observability/metrics.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import { SearchReconciler } from '../modules/search/search-reconciler.js';
import { SearchReconciliationJob } from './search-reconciliation-job.js';
import { createSearchReconciliationLock } from './search-reconciliation-lock.js';

export interface SearchReconciliationComposition {
  job: SearchReconciliationJob;
  lockPool: Pool;
}

export const createSearchReconciliationJob = (
  environment: SearchSchedulerEnvironment,
  prisma: PrismaClient,
  elasticsearch: ElasticsearchClient,
  metrics: ApplicationMetrics,
  logger: Logger,
): SearchReconciliationComposition => {
  const lockPool = new pg.Pool({
    connectionString: environment.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const reconciler = new SearchReconciler(new EventSearchSourceRepository(prisma), elasticsearch);

  return {
    lockPool,
    job: new SearchReconciliationJob({
      reconciler,
      withLock: createSearchReconciliationLock(lockPool),
      metrics,
      logger,
      timeoutMs: environment.SEARCH_RECONCILIATION_TIMEOUT_MS,
    }),
  };
};
