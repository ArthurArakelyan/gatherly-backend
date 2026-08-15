import 'dotenv/config';

import { shutdownTelemetry } from '../instrumentation.js';
import { parseSearchConsumerEnvironment } from '../config/kafka-worker-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { publishDeadLetter } from '../infrastructure/kafka/dead-letter.js';
import { ProcessedEventsRepository } from '../infrastructure/kafka/processed-events.repository.js';
import { startInternalMetricsServer } from '../infrastructure/observability/internal-metrics-server.js';
import { createApplicationMetrics } from '../infrastructure/observability/metrics.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchProjector } from '../modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import {
  PoisonKafkaRecordError,
  SearchProjectionConsumer,
} from '../modules/search/search-projection-consumer.js';
import { createLogger } from '../shared/logging/logger.js';
import { createKafkaConsumerLifetime } from './kafka-consumer-lifetime.js';

const logger = createLogger();
const environment = parseSearchConsumerEnvironment(process.env);
const metrics = createApplicationMetrics();
const metricsServer = startInternalMetricsServer(
  metrics,
  Number(process.env['METRICS_PORT'] ?? 9465),
  logger,
);

const prisma = createPrismaClient(environment);
const elasticsearch = createElasticsearchClient(environment, logger);
const kafka = createKafkaClient(environment, 'search-consumer');
const consumer = kafka.consumer({
  groupId: environment.KAFKA_SEARCH_GROUP_ID,
  allowAutoTopicCreation: false,
  sessionTimeout: 30_000,
  heartbeatInterval: 3_000,
});
const deadLetterProducer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
});

const source = new EventSearchSourceRepository(prisma);
const index = new EventSearchIndex(elasticsearch, environment.ELASTICSEARCH_INDEX_PREFIX, logger);
const handler = new SearchProjectionConsumer(
  environment.KAFKA_SEARCH_GROUP_ID,
  new ProcessedEventsRepository(prisma),
  new EventSearchProjector(source, index),
);
const lifetime = createKafkaConsumerLifetime(consumer, (error) => {
  logger.warn({ err: error }, 'Kafka consumer crashed and will restart');
});

const shutdownController = new AbortController();

const stopConsumer = async (): Promise<void> => {
  try {
    await consumer.stop();
  } catch (error) {
    logger.error({ err: error }, 'Could not stop Kafka consumer cleanly');
    process.exitCode = 1;
  } finally {
    lifetime.complete();
  }
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shutdownController.signal.aborted) return;

  shutdownController.abort(signal);
  logger.info({ signal }, 'Search projection consumer shutdown requested');
  void stopConsumer();
};

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await Promise.all([consumer.connect(), deadLetterProducer.connect()]);
  await consumer.subscribe({
    topic: environment.KAFKA_DOMAIN_EVENTS_TOPIC,
    fromBeginning: true,
  });

  logger.info({ groupId: environment.KAFKA_SEARCH_GROUP_ID }, 'Search projection consumer started');

  await consumer.run({
    partitionsConsumedConcurrently: 2,
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const outcome = await handler.handle({
          topic,
          partition,
          offset: message.offset,
          message,
        });

        metrics.projectionResults.inc({ operation: 'consume', result: outcome });
        if (outcome === 'indexed' || outcome === 'deleted') {
          metrics.projectionLastSuccess.set(Date.now() / 1_000);
        }

        logger.debug({ topic, partition, offset: message.offset, outcome }, 'Domain event handled');
      } catch (error) {
        if (!(error instanceof PoisonKafkaRecordError)) {
          metrics.projectionResults.inc({ operation: 'consume', result: 'failure' });
          throw error;
        }

        await publishDeadLetter(
          deadLetterProducer,
          environment.KAFKA_DEAD_LETTER_TOPIC,
          { topic, partition, message },
          error.message,
          environment.KAFKA_REQUEST_TIMEOUT_MS,
        );
        metrics.projectionResults.inc({
          operation: 'consume',
          result: 'dead_letter',
        });

        logger.warn(
          { topic, partition, offset: message.offset, reason: error.message },
          'Domain event moved to dead-letter topic',
        );
      }
    },
  });

  // KafkaJS run() resolves once the runner has started; it is not the worker's
  // lifetime promise. Wait until shutdown or an unrecoverable consumer crash.
  if (shutdownController.signal.aborted) await stopConsumer();
  await lifetime.completion;
} catch (error) {
  logger.error({ err: error }, 'Search projection consumer stopped unexpectedly');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', requestShutdown);
  process.off('SIGTERM', requestShutdown);
  lifetime.dispose();
  await Promise.allSettled([
    consumer.disconnect(),
    deadLetterProducer.disconnect(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  await new Promise<void>((resolvePromise) => {
    metricsServer.close(() => {
      resolvePromise();
    });
  });
  await shutdownTelemetry();
  logger.info('Search projection consumer stopped');
}
