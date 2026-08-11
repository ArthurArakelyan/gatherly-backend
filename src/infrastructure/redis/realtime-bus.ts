import type { Logger } from 'pino';

import type {
  RealtimeWakeupPublisher,
  RealtimeWakeupTarget,
} from '../../modules/realtime/realtime.types.js';
import { closeRedisClient, type GatherlyRedisClient } from './client.js';

const realtimeChannel = 'gatherly:realtime:wakeup:v1';

export class RedisRealtimeBus implements RealtimeWakeupPublisher {
  private started = false;

  public constructor(
    private readonly publisher: GatherlyRedisClient,
    private readonly subscriber: GatherlyRedisClient,
    private readonly realtimeTarget: RealtimeWakeupTarget,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;

    void this.subscriber
      .connect()
      .then(() =>
        this.subscriber.subscribe(realtimeChannel, () => {
          this.realtimeTarget.wakeAll();
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          'Realtime Redis subscription unavailable; heartbeat replay remains active',
        );
      });
  }

  public wake(): void {
    this.realtimeTarget.wakeAll();
    if (!this.publisher.isReady) return;

    void this.publisher.publish(realtimeChannel, 'wake').catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        'Realtime Redis publish failed; heartbeat replay remains active',
      );
    });
  }

  public async close(): Promise<void> {
    if (this.subscriber.isReady) await this.subscriber.unsubscribe(realtimeChannel);
    await closeRedisClient(this.subscriber);
  }
}

export const createRealtimeSubscriber = (
  publisher: GatherlyRedisClient,
  logger: Logger,
): GatherlyRedisClient => {
  const subscriber = publisher.duplicate();
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'Realtime Redis subscriber error');
  });
  return subscriber;
};
