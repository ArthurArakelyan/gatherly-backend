import { Kafka, logLevel } from 'kafkajs';

interface KafkaConfiguration {
  KAFKA_BROKERS: string[];
  KAFKA_CLIENT_ID: string;
  KAFKA_REQUEST_TIMEOUT_MS: number;
}

export const createKafkaClient = (
  configuration: KafkaConfiguration,
  role: 'outbox-publisher' | 'search-consumer',
): Kafka =>
  new Kafka({
    clientId: `${configuration.KAFKA_CLIENT_ID}-${role}`,
    brokers: configuration.KAFKA_BROKERS,
    connectionTimeout: configuration.KAFKA_REQUEST_TIMEOUT_MS,
    requestTimeout: configuration.KAFKA_REQUEST_TIMEOUT_MS,
    enforceRequestTimeout: true,
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 300,
      retries: 8,
      factor: 0.2,
      multiplier: 2,
      maxRetryTime: 10_000,
    },
  });
