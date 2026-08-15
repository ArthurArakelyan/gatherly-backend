import type { Consumer, ConsumerCrashEvent } from 'kafkajs';

type LifetimeConsumer = Pick<Consumer, 'events' | 'on'>;

export interface KafkaConsumerLifetime {
  completion: Promise<void>;
  complete: () => void;
  dispose: () => void;
}

export const createKafkaConsumerLifetime = (
  consumer: LifetimeConsumer,
  onRestartingCrash: (error: Error) => void,
): KafkaConsumerLifetime => {
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });

  // A crash can occur while consumer.run() is still starting. Attach a handler
  // immediately, then preserve the rejection for the caller awaiting completion.
  void completion.catch(() => undefined);

  const complete = (): void => {
    if (settled) return;
    settled = true;
    resolveCompletion();
  };

  const removeCrashListener = consumer.on(
    consumer.events.CRASH,
    (event: ConsumerCrashEvent): void => {
      if (event.payload.restart) {
        onRestartingCrash(event.payload.error);
        return;
      }

      if (settled) return;
      settled = true;
      rejectCompletion(event.payload.error);
    },
  );

  return {
    completion,
    complete,
    dispose: removeCrashListener,
  };
};
