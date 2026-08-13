import type { KafkaMessage } from 'kafkajs';
import { ZodError } from 'zod';

import type {
  KafkaRecordPosition,
  ProcessedEventsRepository,
} from '../../infrastructure/kafka/processed-events.repository.js';
import {
  EVENT_CHANGED_TYPE,
  eventChangedEnvelopeSchema,
  parseEnvelopeIdentity,
} from '../../shared/events/domain-event.js';
import type { EventSearchProjector } from './event-search-projector.js';

export class PoisonKafkaRecordError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PoisonKafkaRecordError';
  }
}

interface ConsumedRecord extends KafkaRecordPosition {
  message: KafkaMessage;
}

export type SearchProjectionOutcome = 'indexed' | 'deleted' | 'duplicate' | 'ignored';

const decodeJson = (message: KafkaMessage): unknown => {
  if (message.value === null) throw new PoisonKafkaRecordError('Message value is null');
  if (message.value.byteLength > 65_536) {
    throw new PoisonKafkaRecordError('Message value exceeds 65536 bytes');
  }

  try {
    return JSON.parse(message.value.toString('utf8')) as unknown;
  } catch (error) {
    throw new PoisonKafkaRecordError('Message value is not valid JSON', { cause: error });
  }
};

export class SearchProjectionConsumer {
  public constructor(
    private readonly consumerName: string,
    private readonly processedEvents: ProcessedEventsRepository,
    private readonly projector: EventSearchProjector,
  ) {}

  public async handle(record: ConsumedRecord): Promise<SearchProjectionOutcome> {
    const decoded = decodeJson(record.message);

    let identity: ReturnType<typeof parseEnvelopeIdentity>;
    try {
      identity = parseEnvelopeIdentity(decoded);
    } catch (error) {
      throw new PoisonKafkaRecordError('Message has no valid envelope identity', {
        cause: error,
      });
    }

    if (identity.type !== EVENT_CHANGED_TYPE) return 'ignored';

    let envelope;
    try {
      envelope = eventChangedEnvelopeSchema.parse(decoded);
    } catch (error) {
      const reason =
        error instanceof ZodError
          ? `Event envelope validation failed: ${error.issues[0]?.message ?? 'invalid'}`
          : 'Event envelope validation failed';
      throw new PoisonKafkaRecordError(reason, { cause: error });
    }

    const key = record.message.key?.toString('utf8');
    if (key !== envelope.aggregate.id) {
      throw new PoisonKafkaRecordError('Kafka key does not match the event aggregate ID');
    }

    if (await this.processedEvents.hasProcessed(this.consumerName, envelope.id)) {
      return 'duplicate';
    }

    const outcome = await this.projector.sync(envelope.data.eventId);
    await this.processedEvents.markProcessed(this.consumerName, envelope.id, record);
    return outcome;
  }
}
