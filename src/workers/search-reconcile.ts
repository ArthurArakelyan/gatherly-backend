import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { parseSearchSchedulerEnvironment } from '../config/search-scheduler-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { createLogger } from '../shared/logging/logger.js';
import { createSearchReconciliationJob } from './create-search-reconciliation-job.js';

const logger = createLogger();
const environment = parseSearchSchedulerEnvironment(process.env);
const metrics = createApplicationMetrics();
const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const composition = createSearchReconciliationJob(
  environment,
  prisma,
  elasticsearch,
  metrics,
  logger,
);
const controller = new AbortController();

const requestCancellation = (signal: NodeJS.Signals): void => {
  controller.abort(new Error(`Search reconciliation interrupted by ${signal}`));
};

process.once('SIGINT', requestCancellation);
process.once('SIGTERM', requestCancellation);

try {
  const outcome = await composition.job.run({
    trigger: 'manual',
    runId: randomUUID(),
    signal: controller.signal,
  });

  if (outcome.status === 'completed' && outcome.drifted) process.exitCode = 2;
  if (outcome.status === 'cancelled') process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestCancellation);
  process.off('SIGTERM', requestCancellation);
  await Promise.allSettled([
    composition.lockPool.end(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
}
