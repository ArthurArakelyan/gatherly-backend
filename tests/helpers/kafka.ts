import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { Kafka, logLevel } from 'kafkajs';

import { DEAD_LETTER_TOPIC, DOMAIN_EVENTS_TOPIC } from '../../src/shared/events/domain-event.js';

export interface KafkaHarness {
  kafka: Kafka;
  stop: () => Promise<void>;
}

export const startKafkaHarness = async (): Promise<KafkaHarness> => {
  const container: StartedKafkaContainer = await new KafkaContainer('confluentinc/cp-kafka:8.1.4')
    .withKraft()
    .withEnvironment({ KAFKA_HEAP_OPTS: '-Xms128m -Xmx256m' })
    .start();
  const kafka = new Kafka({
    clientId: 'gatherly-integration-test',
    brokers: [`${container.getHost()}:${String(container.getMappedPort(9093))}`],
    logLevel: logLevel.NOTHING,
  });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    waitForLeaders: true,
    topics: [
      { topic: DOMAIN_EVENTS_TOPIC, numPartitions: 3, replicationFactor: 1 },
      { topic: DEAD_LETTER_TOPIC, numPartitions: 3, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();

  return {
    kafka,
    stop: async () => {
      await container.stop();
    },
  };
};
