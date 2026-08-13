import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export const DOMAIN_EVENTS_TOPIC = 'gatherly.domain-events.v1';
export const DEAD_LETTER_TOPIC = 'gatherly.domain-events.dlq.v1';
export const EVENT_CHANGED_TYPE = 'gatherly.event.changed';

const eventChangedDataSchema = z.object({ eventId: z.uuid() }).strict();

export const eventChangedEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.literal(EVENT_CHANGED_TYPE),
    version: z.literal(1),
    occurredAt: z.iso.datetime({ offset: true }),
    aggregate: z
      .object({
        type: z.literal('event'),
        id: z.uuid(),
      })
      .strict(),
    data: eventChangedDataSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.aggregate.id !== event.data.eventId) {
      context.addIssue({
        code: 'custom',
        path: ['aggregate', 'id'],
        message: 'aggregate.id must equal data.eventId',
      });
    }
  });

export type EventChangedEnvelope = z.infer<typeof eventChangedEnvelopeSchema>;

export const createEventChangedEnvelope = (
  eventId: string,
  occurredAt = new Date(),
): EventChangedEnvelope =>
  eventChangedEnvelopeSchema.parse({
    id: randomUUID(),
    type: EVENT_CHANGED_TYPE,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    aggregate: { type: 'event', id: eventId },
    data: { eventId },
  });

const baseEnvelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.string().min(1).max(120),
    version: z.number().int().positive(),
  })
  .loose();

export type EnvelopeIdentity = z.infer<typeof baseEnvelopeSchema>;

export const parseEnvelopeIdentity = (value: unknown): EnvelopeIdentity =>
  baseEnvelopeSchema.parse(value);
