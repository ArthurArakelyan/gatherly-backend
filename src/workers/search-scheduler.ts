import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { parseSearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { startInternalMetricsServer } from '../infrastructure/observability/internal-metrics-server.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { shutdownTelemetry } from '../instrumentation.js';
import { createLogger } from '../shared/logging/logger.js';
import { createSearchReconciliationJob } from './create-search-reconciliation-job.js';
import { createSearchReconciliationScheduler } from './search-reconciliation-scheduler.js';

const logger = createLogger();
const environment = parseSearchSchedulerEnvironment(process.env);
const metrics = createApplicationMetrics();
const metricsServer = startInternalMetricsServer(
  metrics,
  environment.SCHEDULER_METRICS_PORT,
  logger,
);
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const composition = createSearchReconciliationJob(
  environment,
  prisma,
  elasticsearch,
  metrics,
  logger,
);
const scheduler = createSearchReconciliationScheduler({
  cronExpression: environment.SEARCH_RECONCILIATION_CRON,
  job: composition.job,
  logger,
});

let resolveStopped!: () => void;
const stopped = new Promise<void>((resolve) => {
  resolveStopped = resolve;
});
let shutdownPromise: Promise<void> | undefined;

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shutdownPromise !== undefined) return;

  shutdownPromise = (async () => {
    try {
      logger.info({ signal }, 'Search scheduler shutdown requested');
      const result = await scheduler.shutdown(environment.SCHEDULER_SHUTDOWN_TIMEOUT_MS);
      if (result.forced) process.exitCode = 1;
    } catch (error) {
      logger.error({ err: error }, 'Search scheduler shutdown failed');
      process.exitCode = 1;
    } finally {
      resolveStopped();
    }
  })();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await scheduler.start();
  logger.info(
    { processRunId: randomUUID() },
    'Search scheduler process is accepting scheduled work',
  );
  await stopped;
} catch (error) {
  logger.error({ err: error }, 'Search scheduler stopped unexpectedly');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestShutdown);
  process.off('SIGTERM', requestShutdown);
  await Promise.allSettled([
    composition.lockPool.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  await new Promise<void>((resolve) =>
    metricsServer.close(() => {
      resolve();
    }),
  );
  await shutdownTelemetry();
  logger.info('Search scheduler process stopped');
}
