import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createEventRequestSchema } from '../../src/modules/events/events.schemas.js';

const validRequest = {
  body: {
    title: 'Board games',
    slug: 'board-games',
    startsAt: '2030-08-03T18:00:00.000Z',
    endsAt: '2030-08-03T21:00:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 10,
  },
  params: { communityId: randomUUID() },
  query: {},
};

describe('createEventRequestSchema', () => {
  it('normalizes defaults and date strings at the HTTP boundary', () => {
    const parsed = createEventRequestSchema.parse(validRequest);

    expect(parsed.body.startsAt).toBeInstanceOf(Date);
    expect(parsed.body.description).toBe('');
    expect(parsed.body.format).toBe('IN_PERSON');
    expect(parsed.body.visibility).toBe('PUBLIC');
  });

  it('rejects an event whose end is not after its start', () => {
    const result = createEventRequestSchema.safeParse({
      ...validRequest,
      body: { ...validRequest.body, endsAt: validRequest.body.startsAt },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an invalid IANA time-zone identifier', () => {
    const result = createEventRequestSchema.safeParse({
      ...validRequest,
      body: { ...validRequest.body, timezone: 'Mars/Olympus' },
    });

    expect(result.success).toBe(false);
  });
});
