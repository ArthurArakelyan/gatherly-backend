import { describe, expect, it } from 'vitest';

import {
  createEventChangedEnvelope,
  eventChangedEnvelopeSchema,
  parseEnvelopeIdentity,
} from '../../src/shared/events/domain-event.js';

describe('event changed envelope', () => {
  const eventId = '00000000-0000-4000-8000-000000000001';

  it('creates a versioned envelope with one consistent aggregate ID', () => {
    const envelope = createEventChangedEnvelope(eventId, new Date('2030-08-03T18:00:00.000Z'));

    expect(envelope).toMatchObject({
      type: 'gatherly.event.changed',
      version: 1,
      occurredAt: '2030-08-03T18:00:00.000Z',
      aggregate: { type: 'event', id: eventId },
      data: { eventId },
    });
    expect(envelope.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('rejects mismatched aggregate and payload IDs', () => {
    const envelope = createEventChangedEnvelope(eventId);

    expect(() =>
      eventChangedEnvelopeSchema.parse({
        ...envelope,
        data: { eventId: '00000000-0000-4000-8000-000000000002' },
      }),
    ).toThrow('aggregate.id must equal data.eventId');
  });

  it('rejects unsupported versions and unknown fields on the known schema', () => {
    const envelope = createEventChangedEnvelope(eventId);

    expect(() => eventChangedEnvelopeSchema.parse({ ...envelope, version: 2 })).toThrow();
    expect(() => eventChangedEnvelopeSchema.parse({ ...envelope, unexpected: true })).toThrow();
  });

  it('reads identity from an unrelated extensible envelope', () => {
    expect(
      parseEnvelopeIdentity({
        id: '00000000-0000-4000-8000-000000000010',
        type: 'gatherly.example.created',
        version: 3,
        data: { ignored: true },
      }),
    ).toMatchObject({
      id: '00000000-0000-4000-8000-000000000010',
      type: 'gatherly.example.created',
      version: 3,
    });
  });
});
