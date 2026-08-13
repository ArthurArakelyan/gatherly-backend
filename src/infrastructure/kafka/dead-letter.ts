import { randomUUID } from 'node:crypto';

import type { KafkaMessage, Producer } from 'kafkajs';

interface DeadLetterSource {
  topic: string;
  partition: number;
  message: KafkaMessage;
}

const bounded = (value: string, maximum: number): string => value.slice(0, maximum);

export const publishDeadLetter = async (
  producer: Producer,
  deadLetterTopic: string,
  source: DeadLetterSource,
  reason: string,
  requestTimeoutMs: number,
): Promise<void> => {
  const record = {
    id: randomUUID(),
    failedAt: new Date().toISOString(),
    reason: bounded(reason, 1_000),
    source: {
      topic: source.topic,
      partition: source.partition,
      offset: source.message.offset,
      keyBase64: source.message.key?.toString('base64') ?? null,
      valueBase64: source.message.value?.subarray(0, 65_536).toString('base64') ?? null,
      valueTruncated: (source.message.value?.byteLength ?? 0) > 65_536,
    },
  };

  await producer.send({
    topic: deadLetterTopic,
    acks: -1,
    timeout: requestTimeoutMs,
    messages: [
      {
        key: source.message.key,
        value: JSON.stringify(record),
        headers: {
          'dead-letter-id': record.id,
          'source-topic': source.topic,
          'source-partition': String(source.partition),
          'source-offset': source.message.offset,
          'content-type': 'application/json',
        },
      },
    ],
  });
};
