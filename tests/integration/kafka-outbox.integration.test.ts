import { randomUUID } from 'node:crypto';

import type { Consumer, Producer, ProducerRecord } from 'kafkajs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OutboxRepository } from '../../src/infrastructure/kafka/outbox.repository.js';
import { EventsRepository } from '../../src/modules/events/events.repository.js';
import {
  createEventChangedEnvelope,
  DOMAIN_EVENTS_TOPIC,
} from '../../src/shared/events/domain-event.js';
import { aliceId, createCommunityFixture } from '../fixtures/database.js';
import { type KafkaHarness, startKafkaHarness } from '../helpers/kafka.js';
import { type PostgresHarness, startPostgresHarness } from '../helpers/postgres.js';

describe('Kafka transactional outbox', { concurrent: false }, () => {
  let postgres: PostgresHarness;
  let kafka: KafkaHarness;
  let producer: Producer;
  let consumer: Consumer;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    postgres = await startPostgresHarness();
    cleanups.push(postgres.stop);
    kafka = await startKafkaHarness();
    cleanups.push(kafka.stop);
    producer = kafka.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
      maxInFlightRequests: 5,
    });
    consumer = kafka.kafka.consumer({ groupId: `outbox-test-${randomUUID()}` });
    cleanups.push(async () => {
      await Promise.allSettled([producer.disconnect(), consumer.disconnect()]);
    });
    await Promise.all([producer.connect(), consumer.connect()]);
    await consumer.subscribe({ topic: DOMAIN_EVENTS_TOPIC, fromBeginning: true });
  }, 180_000);

  beforeEach(async () => {
    await postgres.reset();
    await postgres.seed();
  });

  afterAll(async () => {
    await Promise.allSettled(cleanups.reverse().map(async (cleanup) => cleanup()));
  });

  it('commits one outbox envelope with an authorized event', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    const repository = new EventsRepository(postgres.prisma);

    const event = await repository.create(communityId, aliceId, {
      title: 'Kafka pottery',
      slug: 'kafka-pottery',
      description: '',
      format: 'IN_PERSON',
      visibility: 'PUBLIC',
      startsAt: new Date('2030-08-03T18:00:00.000Z'),
      endsAt: new Date('2030-08-03T20:00:00.000Z'),
      timezone: 'Europe/Moscow',
      capacity: 10,
    });

    const outbox = await postgres.prisma.outboxEvent.findMany();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      topic: DOMAIN_EVENTS_TOPIC,
      eventKey: event.id,
      eventType: 'gatherly.event.changed',
      eventVersion: 1,
      publishedAt: null,
      publishAttempts: 0,
    });
    expect(outbox[0]?.payload).toMatchObject({
      aggregate: { type: 'event', id: event.id },
      data: { eventId: event.id },
    });
  });

  it('rolls back the event when its outbox insert fails', async () => {
    const communityId = await createCommunityFixture(postgres.pool);
    await postgres.pool.query(`
      CREATE FUNCTION kafka_test_fail_outbox_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $$;

      CREATE TRIGGER kafka_test_fail_outbox_insert_trigger
      BEFORE INSERT ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION kafka_test_fail_outbox_insert();
    `);

    try {
      const repository = new EventsRepository(postgres.prisma);
      await expect(
        repository.create(communityId, aliceId, {
          title: 'Must roll back',
          slug: 'must-roll-back',
          description: '',
          format: 'IN_PERSON',
          visibility: 'PUBLIC',
          startsAt: new Date('2030-08-03T18:00:00.000Z'),
          endsAt: new Date('2030-08-03T20:00:00.000Z'),
          timezone: 'Europe/Moscow',
          capacity: 10,
        }),
      ).rejects.toThrow('injected outbox failure');

      const state = await postgres.pool.query<{ events: number; outbox: number }>(`
        SELECT
          (SELECT count(*)::integer FROM events WHERE slug = 'must-roll-back') AS events,
          (SELECT count(*)::integer FROM outbox_events) AS outbox
      `);
      expect(state.rows[0]).toEqual({ events: 0, outbox: 0 });
    } finally {
      await postgres.pool.query(`
        DROP TRIGGER IF EXISTS kafka_test_fail_outbox_insert_trigger ON outbox_events;
        DROP FUNCTION IF EXISTS kafka_test_fail_outbox_insert();
      `);
    }
  });

  it('publishes the same envelope again after send succeeds but marking fails', async () => {
    const eventId = randomUUID();
    const envelope = createEventChangedEnvelope(eventId);
    await postgres.prisma.outboxEvent.create({
      data: {
        id: envelope.id,
        topic: DOMAIN_EVENTS_TOPIC,
        eventKey: eventId,
        eventType: envelope.type,
        eventVersion: envelope.version,
        payload: envelope,
        occurredAt: new Date(envelope.occurredAt),
      },
    });

    const receivedIds: string[] = [];
    let resolveTwo!: () => void;
    const receivedTwo = new Promise<void>((resolve) => {
      resolveTwo = resolve;
    });
    const runPromise = consumer.run({
      eachMessage: ({ message }) => {
        const parsed = JSON.parse(message.value?.toString('utf8') ?? 'null') as {
          id?: string;
        };
        if (parsed.id === envelope.id) receivedIds.push(parsed.id);
        if (receivedIds.length === 2) resolveTwo();
        return Promise.resolve();
      },
    });

    await postgres.pool.query(`
      CREATE FUNCTION kafka_test_fail_publish_mark()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.published_at IS NOT NULL THEN
          RAISE EXCEPTION 'injected publish marker failure';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER kafka_test_fail_publish_mark_trigger
      BEFORE UPDATE ON outbox_events
      FOR EACH ROW
      EXECUTE FUNCTION kafka_test_fail_publish_mark();
    `);

    const repository = new OutboxRepository(postgres.prisma, 7_000);
    const publish = async (record: ProducerRecord): Promise<void> => {
      await producer.send({ ...record, acks: -1, timeout: 5_000 });
    };

    try {
      await expect(repository.publishNext(publish)).rejects.toThrow(
        'injected publish marker failure',
      );
      const afterFailure = await postgres.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: envelope.id },
      });
      expect(afterFailure.publishedAt).toBeNull();
    } finally {
      await postgres.pool.query(`
        DROP TRIGGER IF EXISTS kafka_test_fail_publish_mark_trigger ON outbox_events;
        DROP FUNCTION IF EXISTS kafka_test_fail_publish_mark();
      `);
    }

    await expect(repository.publishNext(publish)).resolves.toBe(true);
    await expect(receivedTwo).resolves.toBeUndefined();
    expect(receivedIds).toEqual([envelope.id, envelope.id]);

    const published = await postgres.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: envelope.id },
    });
    expect(published.publishedAt).not.toBeNull();
    expect(published.publishAttempts).toBe(2);

    await consumer.stop();
    await runPromise;
  }, 30_000);
});
