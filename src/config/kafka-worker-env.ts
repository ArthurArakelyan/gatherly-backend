import { z } from 'zod';

import { DEAD_LETTER_TOPIC, DOMAIN_EVENTS_TOPIC } from '../shared/events/domain-event.js';
import { elasticsearchEnvironmentShape } from './elasticsearch-environment.js';

const brokersSchema = z
  .string()
  .transform((value) => value.split(',').map((broker) => broker.trim()))
  .pipe(z.array(z.string().min(1)).min(1));

const databaseShape = {
  DATABASE_URL: z.url(),
  PRISMA_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
};

const kafkaShape = {
  KAFKA_BROKERS: brokersSchema,
  KAFKA_CLIENT_ID: z.string().min(1).max(100).default('gatherly'),
  KAFKA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
};

const outboxPublisherEnvironmentSchema = z.object({
  ...databaseShape,
  ...kafkaShape,
  KAFKA_DOMAIN_EVENTS_TOPIC: z.literal(DOMAIN_EVENTS_TOPIC).default(DOMAIN_EVENTS_TOPIC),
  KAFKA_OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  KAFKA_OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
});

const searchConsumerEnvironmentSchema = z.object({
  ...databaseShape,
  ...kafkaShape,
  ...elasticsearchEnvironmentShape,
  KAFKA_DOMAIN_EVENTS_TOPIC: z.literal(DOMAIN_EVENTS_TOPIC).default(DOMAIN_EVENTS_TOPIC),
  KAFKA_DEAD_LETTER_TOPIC: z.literal(DEAD_LETTER_TOPIC).default(DEAD_LETTER_TOPIC),
  KAFKA_SEARCH_GROUP_ID: z.string().min(1).max(200).default('gatherly-search-projection-v1'),
});

export type OutboxPublisherEnvironment = z.infer<typeof outboxPublisherEnvironmentSchema>;
export type SearchConsumerEnvironment = z.infer<typeof searchConsumerEnvironmentSchema>;

export const parseOutboxPublisherEnvironment = (
  input: NodeJS.ProcessEnv,
): OutboxPublisherEnvironment => outboxPublisherEnvironmentSchema.parse(input);

export const parseSearchConsumerEnvironment = (
  input: NodeJS.ProcessEnv,
): SearchConsumerEnvironment => searchConsumerEnvironmentSchema.parse(input);
