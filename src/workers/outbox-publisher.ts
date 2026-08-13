import 'dotenv/config';

import pino from 'pino';

import { parseOutboxPublisherEnvironment } from '../config/kafka-worker-env.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { OutboxRepository } from '../infrastructure/kafka/outbox.repository.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { OutboxPublisherRunner } from './outbox-publisher-runner.js';

const logger = pino();
const environment = parseOutboxPublisherEnvironment(process.env);
const prisma = createPrismaClient(environment);
const kafka = createKafkaClient(environment, 'outbox-publisher');
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});
const abortController = new AbortController();

let stopping = false;
const requestShutdown = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Outbox publisher shutdown requested');
  abortController.abort();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await producer.connect();
  const repository = new OutboxRepository(prisma, environment.KAFKA_REQUEST_TIMEOUT_MS + 2_000);
  const runner = new OutboxPublisherRunner(repository, producer, logger, {
    batchSize: environment.KAFKA_OUTBOX_BATCH_SIZE,
    idleDelayMs: environment.KAFKA_OUTBOX_POLL_INTERVAL_MS,
    failureDelayMs: 1_000,
    requestTimeoutMs: environment.KAFKA_REQUEST_TIMEOUT_MS,
  });

  logger.info('Outbox publisher started');
  await runner.run(abortController.signal);
} catch (error) {
  logger.error({ err: error }, 'Outbox publisher stopped unexpectedly');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([producer.disconnect(), prisma.$disconnect()]);
  logger.info('Outbox publisher stopped');
}
