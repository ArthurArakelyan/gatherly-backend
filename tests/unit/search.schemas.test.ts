import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  searchEventsRequestSchema,
  suggestEventsRequestSchema,
} from '../../src/modules/search/search.schemas.js';

describe('search request schemas', () => {
  it('applies defaults and transforms supported event-search filters', () => {
    const parsed = searchEventsRequestSchema.parse({
      body: undefined,
      params: {},
      query: {
        q: '  pottery  ',
        communityId: randomUUID(),
        format: 'IN_PERSON',
        city: '  Moscow ',
        startsAfter: '2030-08-03T18:00:00.000Z',
      },
    });

    expect(parsed.query).toMatchObject({
      q: 'pottery',
      format: 'IN_PERSON',
      city: 'Moscow',
      country: null,
      limit: 20,
      after: null,
    });
    expect(parsed.query.startsAfter).toEqual(new Date('2030-08-03T18:00:00.000Z'));
  });

  it.each([
    ['unknown filter', { extra: 'value' }],
    ['invalid community ID', { communityId: 'bad' }],
    ['invalid format', { format: 'PHONE' }],
    ['excessive limit', { limit: 51 }],
    [
      'reversed range',
      {
        startsAfter: '2030-08-04T18:00:00.000Z',
        startsBefore: '2030-08-03T18:00:00.000Z',
      },
    ],
  ])('rejects %s', (_case, query) => {
    expect(
      searchEventsRequestSchema.safeParse({ body: undefined, params: {}, query }).success,
    ).toBe(false);
  });

  it('requires a bounded two-character suggestion and applies its default limit', () => {
    expect(
      suggestEventsRequestSchema.parse({ body: undefined, params: {}, query: { q: '  wo ' } }),
    ).toMatchObject({ query: { q: 'wo', limit: 8 } });
    expect(
      suggestEventsRequestSchema.safeParse({ body: undefined, params: {}, query: { q: 'w' } })
        .success,
    ).toBe(false);
    expect(
      suggestEventsRequestSchema.safeParse({
        body: undefined,
        params: {},
        query: { q: 'wood', limit: 11 },
      }).success,
    ).toBe(false);
  });
});
