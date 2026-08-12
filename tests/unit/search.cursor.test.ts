import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeSearchCursor,
  encodeSearchCursor,
  fingerprintSearchQuery,
} from '../../src/modules/search/search.cursor.js';
import type { EventSearchQuery } from '../../src/modules/search/search.types.js';

const query: EventSearchQuery = {
  q: 'pottery',
  communityId: randomUUID(),
  format: 'IN_PERSON',
  city: 'Moscow',
  country: 'Russia',
  startsAfter: new Date('2030-01-01T00:00:00.000Z'),
  startsBefore: null,
  after: null,
  limit: 20,
};

describe('search cursor', () => {
  it('round-trips a strict opaque cursor payload', () => {
    const cursor = {
      v: 1 as const,
      pitId: 'pit-id',
      fingerprint: fingerprintSearchQuery(query),
      sort: [12.5, '2030-08-03T18:00:00.000Z', randomUUID()],
    };

    expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor);
  });

  it('fingerprints search semantics but permits a different page size', () => {
    expect(fingerprintSearchQuery({ ...query, limit: 5 })).toBe(fingerprintSearchQuery(query));
    expect(fingerprintSearchQuery({ ...query, city: 'Kazan' })).not.toBe(
      fingerprintSearchQuery(query),
    );
  });

  it.each([
    'not-base64-json',
    Buffer.from(JSON.stringify({ v: 2, pitId: 'pit', fingerprint: 'bad', sort: [] })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({
        v: 1,
        pitId: 'pit',
        fingerprint: 'a'.repeat(64),
        sort: [1, 2],
        extra: true,
      }),
    ).toString('base64url'),
  ])('rejects an invalid cursor', (cursor) => {
    expect(() => decodeSearchCursor(cursor)).toThrow(
      expect.objectContaining({ code: 'INVALID_SEARCH_CURSOR', status: 400 }),
    );
  });
});
