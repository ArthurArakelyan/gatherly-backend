import 'dotenv/config';

import pino from 'pino';

import { parseSearchConsumerEnvironment } from '../config/kafka-worker-env.js';
import {
  closeElasticsearchClient,
  createElasticsearchClient,
} from '../infrastructure/elasticsearch/client.js';
import { EventSearchIndex } from '../infrastructure/elasticsearch/event-search-index.js';
import { createKafkaClient } from '../infrastructure/kafka/client.js';
import { publishDeadLetter } from '../infrastructure/kafka/dead-letter.js';
import { ProcessedEventsRepository } from '../infrastructure/kafka/processed-events.repository.js';
import { createPrismaClient } from '../infrastructure/prisma/client.js';
import { EventSearchProjector } from '../modules/search/event-search-projector.js';
import { EventSearchSourceRepository } from '../modules/search/event-search-source.repository.js';
import {
  PoisonKafkaRecordError,
  SearchProjectionConsumer,
} from '../modules/search/search-projection-consumer.js';

const logger = pino();
const environment = parseSearchConsumerEnvironment(process.env);
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

let stopping = false;
const requestShutdown = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Search projection consumer shutdown requested');
  void consumer.stop().catch((error: unknown) => {
    logger.error({ err: error }, 'Could not stop Kafka consumer cleanly');
    process.exitCode = 1;
  });
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
        logger.debug({ topic, partition, offset: message.offset, outcome }, 'Domain event handled');
      } catch (error) {
        if (!(error instanceof PoisonKafkaRecordError)) throw error;

        await publishDeadLetter(
          deadLetterProducer,
          environment.KAFKA_DEAD_LETTER_TOPIC,
          { topic, partition, message },
          error.message,
          environment.KAFKA_REQUEST_TIMEOUT_MS,
        );
        logger.warn(
          { topic, partition, offset: message.offset, reason: error.message },
          'Domain event moved to dead-letter topic',
        );
      }
    },
  });
} catch (error) {
  logger.error({ err: error }, 'Search projection consumer stopped unexpectedly');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    consumer.disconnect(),
    deadLetterProducer.disconnect(),
    prisma.$disconnect(),
    closeElasticsearchClient(elasticsearch),
  ]);
  logger.info('Search projection consumer stopped');
}
