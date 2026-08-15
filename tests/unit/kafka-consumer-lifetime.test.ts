import type { Consumer, ConsumerCrashEvent } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import { createKafkaConsumerLifetime } from '../../src/workers/kafka-consumer-lifetime.js';

const createConsumer = () => {
  let crashListener: ((event: ConsumerCrashEvent) => void) | undefined;
  const removeListener = vi.fn();
  const consumer = {
    events: { CRASH: 'consumer.crash' },
    on: vi.fn((_eventName, listener: (event: ConsumerCrashEvent) => void) => {
      crashListener = listener;
      return removeListener;
    }),
  } as unknown as Pick<Consumer, 'events' | 'on'>;

  const crash = (error: Error, restart: boolean): void => {
    crashListener?.({ payload: { error, groupId: 'search-v1', restart } } as ConsumerCrashEvent);
  };

  return { consumer, crash, removeListener };
};

describe('createKafkaConsumerLifetime', () => {
  it('stays pending after startup until explicitly completed', async () => {
    const dependencies = createConsumer();
    const onRestartingCrash = vi.fn();
    const lifetime = createKafkaConsumerLifetime(dependencies.consumer, onRestartingCrash);
    const settled = vi.fn();
    void lifetime.completion.then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    lifetime.complete();
    await expect(lifetime.completion).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('keeps waiting when KafkaJS will restart after a crash', async () => {
    const dependencies = createConsumer();
    const onRestartingCrash = vi.fn();
    const lifetime = createKafkaConsumerLifetime(dependencies.consumer, onRestartingCrash);
    const settled = vi.fn();
    void lifetime.completion.then(settled);
    const error = new Error('temporary broker outage');

    dependencies.crash(error, true);
    await Promise.resolve();

    expect(onRestartingCrash).toHaveBeenCalledWith(error);
    expect(settled).not.toHaveBeenCalled();
    lifetime.complete();
    await lifetime.completion;
  });

  it('rejects when KafkaJS cannot recover from a crash', async () => {
    const dependencies = createConsumer();
    const lifetime = createKafkaConsumerLifetime(dependencies.consumer, vi.fn());
    const error = new Error('consumer exhausted retries');

    dependencies.crash(error, false);

    await expect(lifetime.completion).rejects.toBe(error);
  });

  it('removes its crash listener when disposed', () => {
    const dependencies = createConsumer();
    const lifetime = createKafkaConsumerLifetime(dependencies.consumer, vi.fn());

    lifetime.dispose();

    expect(dependencies.removeListener).toHaveBeenCalledOnce();
  });
});
