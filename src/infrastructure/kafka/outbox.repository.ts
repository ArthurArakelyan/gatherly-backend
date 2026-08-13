import type { ProducerRecord } from 'kafkajs';

import { type Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  DOMAIN_EVENTS_TOPIC,
  eventChangedEnvelopeSchema,
} from '../../shared/events/domain-event.js';

interface LockedOutboxRow {
  id: string;
  topic: string;
  eventKey: string;
  payload: Prisma.JsonValue;
}

export type PublishOutboxRecord = (record: ProducerRecord) => Promise<void>;

const safeError = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return text.slice(0, 2_000);
};

export class OutboxRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly transactionTimeoutMs: number,
  ) {}

  public async publishNext(publish: PublishOutboxRecord): Promise<boolean> {
    let selectedId: string | undefined;

    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const rows = await transaction.$queryRaw<LockedOutboxRow[]>`
            SELECT
              id::text,
              topic,
              event_key AS "eventKey",
              payload
            FROM outbox_events AS candidate
            WHERE candidate.published_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM outbox_events AS predecessor
                WHERE predecessor.event_key = candidate.event_key
                  AND predecessor.published_at IS NULL
                  AND (predecessor.occurred_at, predecessor.id)
                    < (candidate.occurred_at, candidate.id)
              )
            ORDER BY candidate.occurred_at ASC, candidate.id ASC
            FOR UPDATE OF candidate SKIP LOCKED
            LIMIT 1
          `;

          const row = rows[0];
          if (row === undefined) return false;
          selectedId = row.id;

          const envelope = eventChangedEnvelopeSchema.parse(row.payload);
          if (row.topic !== DOMAIN_EVENTS_TOPIC) {
            throw new Error('Outbox row targets an unsupported topic');
          }
          if (row.eventKey !== envelope.aggregate.id) {
            throw new Error('Outbox key does not match its aggregate ID');
          }

          await publish({
            topic: row.topic,
            messages: [
              {
                key: row.eventKey,
                value: JSON.stringify(envelope),
                timestamp: String(new Date(envelope.occurredAt).getTime()),
                headers: {
                  'event-id': envelope.id,
                  'event-type': envelope.type,
                  'event-version': String(envelope.version),
                  'content-type': 'application/json',
                },
              },
            ],
          });

          const update = await transaction.outboxEvent.updateMany({
            where: { id: row.id, publishedAt: null },
            data: {
              publishedAt: new Date(),
              publishAttempts: { increment: 1 },
              lastError: null,
            },
          });
          if (update.count !== 1) throw new Error('Locked outbox row was not updated');
          return true;
        },
        { maxWait: 2_000, timeout: this.transactionTimeoutMs },
      );
    } catch (error) {
      if (selectedId !== undefined) {
        try {
          await this.prisma.outboxEvent.updateMany({
            where: { id: selectedId, publishedAt: null },
            data: {
              publishAttempts: { increment: 1 },
              lastError: safeError(error),
            },
          });
        } catch (recordingError) {
          throw new AggregateError(
            [error, recordingError],
            'Outbox publication and failure recording both failed',
            { cause: recordingError },
          );
        }
      }
      throw error;
    }
  }
}
