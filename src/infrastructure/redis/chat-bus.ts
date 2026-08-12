import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type {
  ChatSignal,
  ChatSignalPublisher,
  ChatSignalTarget,
} from '../../modules/chat/chat.types.js';
import { closeRedisClient, type GatherlyRedisClient } from './client.js';

const chatChannel = 'gatherly:chat:signals:v1';

const chatSignalSchema: z.ZodType<ChatSignal> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message.created'), eventId: z.uuid(), messageId: z.uuid() }),
  z.strictObject({ kind: z.literal('message.deleted'), eventId: z.uuid(), messageId: z.uuid() }),
  z.strictObject({
    kind: z.literal('typing.updated'),
    eventId: z.uuid(),
    userId: z.uuid(),
    username: z.string().min(1),
    isTyping: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('presence.updated'),
    eventId: z.uuid(),
    userId: z.uuid(),
    username: z.string().min(1),
    online: z.boolean(),
  }),
]);

const envelopeSchema = z.strictObject({
  origin: z.uuid(),
  signal: chatSignalSchema,
});

export class RedisChatBus implements ChatSignalPublisher {
  private readonly instanceId = randomUUID();
  private target: ChatSignalTarget | undefined;
  private started = false;

  public constructor(
    private readonly publisher: GatherlyRedisClient,
    private readonly subscriber: GatherlyRedisClient,
    private readonly logger: Logger,
  ) {}

  public start(target: ChatSignalTarget): void {
    if (this.started) return;
    this.started = true;
    this.target = target;

    void this.subscriber
      .connect()
      .then(() =>
        this.subscriber.subscribe(chatChannel, (value) => {
          try {
            const parsedJson: unknown = JSON.parse(value);
            const envelope = envelopeSchema.parse(parsedJson);
            if (envelope.origin === this.instanceId) return;
            void this.deliverLocally(envelope.signal);
          } catch (error) {
            this.logger.warn({ err: error }, 'Discarding invalid chat Pub/Sub signal');
          }
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Chat Redis subscription unavailable');
      });
  }

  public publish(signal: ChatSignal): void {
    void this.deliverLocally(signal);
    if (!this.publisher.isReady) return;

    const envelope = JSON.stringify({ origin: this.instanceId, signal });
    void this.publisher.publish(chatChannel, envelope).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Chat Redis publication failed');
    });
  }

  public async close(): Promise<void> {
    this.target = undefined;
    if (this.subscriber.isReady) await this.subscriber.unsubscribe(chatChannel);
    await closeRedisClient(this.subscriber);
  }

  private async deliverLocally(signal: ChatSignal): Promise<void> {
    try {
      await this.target?.handleSignal(signal);
    } catch (error) {
      this.logger.warn({ err: error, kind: signal.kind }, 'Local chat signal failed');
    }
  }
}

export const createChatSubscriber = (
  publisher: GatherlyRedisClient,
  logger: Logger,
): GatherlyRedisClient => {
  const subscriber = publisher.duplicate();
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'Chat Redis subscriber error');
  });
  return subscriber;
};
