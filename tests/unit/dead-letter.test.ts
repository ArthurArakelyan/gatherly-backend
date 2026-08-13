import type { KafkaMessage, Producer } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import { publishDeadLetter } from '../../src/infrastructure/kafka/dead-letter.js';

const message = (value: Buffer): KafkaMessage => ({
  key: Buffer.from('event-key'),
  value,
  timestamp: '1912010400000',
  attributes: 0,
  offset: '42',
  headers: {},
});

describe('publishDeadLetter', () => {
  it('publishes bounded source context with source-position headers', async () => {
    const send = vi.fn().mockResolvedValue([]);
    const producer = { send } as unknown as Producer;
    const reason = 'x'.repeat(1_100);

    await publishDeadLetter(
      producer,
      'gatherly.domain-events.dlq.v1',
      {
        topic: 'gatherly.domain-events.v1',
        partition: 2,
        message: message(Buffer.from('{broken')),
      },
      reason,
      5_000,
    );

    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]?.[0] as
      | {
          topic: string;
          messages: { value: string; headers: Record<string, string> }[];
        }
      | undefined;
    if (request === undefined) throw new Error('Dead-letter producer was not called');
    const produced = request.messages[0];
    if (produced === undefined) throw new Error('Dead-letter request had no message');
    const record = JSON.parse(produced.value) as {
      reason: string;
      source: {
        topic: string;
        partition: number;
        offset: string;
        valueBase64: string;
        valueTruncated: boolean;
      };
    };

    expect(request.topic).toBe('gatherly.domain-events.dlq.v1');
    expect(record.reason).toHaveLength(1_000);
    expect(record.source).toEqual({
      topic: 'gatherly.domain-events.v1',
      partition: 2,
      offset: '42',
      keyBase64: Buffer.from('event-key').toString('base64'),
      valueBase64: Buffer.from('{broken').toString('base64'),
      valueTruncated: false,
    });
    expect(produced.headers).toMatchObject({
      'source-topic': 'gatherly.domain-events.v1',
      'source-partition': '2',
      'source-offset': '42',
    });
  });

  it('truncates oversized values and propagates broker failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Kafka unavailable'));
    const producer = { send } as unknown as Producer;

    await expect(
      publishDeadLetter(
        producer,
        'gatherly.domain-events.dlq.v1',
        {
          topic: 'gatherly.domain-events.v1',
          partition: 0,
          message: message(Buffer.alloc(65_537, 1)),
        },
        'oversized',
        5_000,
      ),
    ).rejects.toThrow('Kafka unavailable');

    const request = send.mock.calls[0]?.[0] as { messages: { value: string }[] } | undefined;
    if (request === undefined) throw new Error('Dead-letter producer was not called');
    const produced = request.messages[0];
    if (produced === undefined) throw new Error('Dead-letter request had no message');
    const record = JSON.parse(produced.value) as {
      source: { valueBase64: string; valueTruncated: boolean };
    };
    expect(Buffer.from(record.source.valueBase64, 'base64')).toHaveLength(65_536);
    expect(record.source.valueTruncated).toBe(true);
  });
});
