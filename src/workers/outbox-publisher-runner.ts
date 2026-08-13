import type { Producer } from 'kafkajs';
import type { Logger } from 'pino';

import type { OutboxRepository } from '../infrastructure/kafka/outbox.repository.js';

interface OutboxPublisherOptions {
  batchSize: number;
  idleDelayMs: number;
  failureDelayMs: number;
  requestTimeoutMs: number;
}

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref();
    signal.addEventListener('abort', finish, { once: true });
  });

export class OutboxPublisherRunner {
  public constructor(
    private readonly repository: OutboxRepository,
    private readonly producer: Producer,
    private readonly logger: Logger,
    private readonly options: OutboxPublisherOptions,
  ) {}

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let published = 0;

      try {
        for (let index = 0; index < this.options.batchSize; index += 1) {
          const found = await this.repository.publishNext(async (record) => {
            await this.producer.send({
              ...record,
              acks: -1,
              timeout: this.options.requestTimeoutMs,
            });
          });
          if (!found) break;
          published += 1;
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox publication attempt failed');
        await delay(this.options.failureDelayMs, signal);
        continue;
      }

      if (published > 0) {
        this.logger.debug({ published }, 'Published outbox batch');
      } else {
        await delay(this.options.idleDelayMs, signal);
      }
    }
  }
}
