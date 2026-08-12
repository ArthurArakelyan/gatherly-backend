import { describe, expect, it } from 'vitest';

import { parseSearchReindexEnvironment } from '../../src/config/search-reindex-env.js';

describe('search reindex environment', () => {
  it('requires only Prisma and Elasticsearch settings', () => {
    expect(
      parseSearchReindexEnvironment({
        DATABASE_URL: 'postgresql://gatherly:password@127.0.0.1:5432/gatherly',
        ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
      }),
    ).toEqual({
      DATABASE_URL: 'postgresql://gatherly:password@127.0.0.1:5432/gatherly',
      PRISMA_POOL_MAX: 5,
      ELASTICSEARCH_URL: 'http://127.0.0.1:9200',
      ELASTICSEARCH_API_KEY: undefined,
      ELASTICSEARCH_REQUEST_TIMEOUT_MS: 2_000,
      ELASTICSEARCH_INDEX_PREFIX: 'gatherly-events',
    });
  });

  it('normalizes an empty API key and rejects invalid connection settings', () => {
    expect(
      parseSearchReindexEnvironment({
        DATABASE_URL: 'postgresql://gatherly:password@127.0.0.1:5432/gatherly',
        ELASTICSEARCH_URL: 'https://search.example.com',
        ELASTICSEARCH_API_KEY: '   ',
      }).ELASTICSEARCH_API_KEY,
    ).toBeUndefined();

    expect(() =>
      parseSearchReindexEnvironment({
        DATABASE_URL: 'not-a-url',
        ELASTICSEARCH_URL: 'redis://127.0.0.1:6379',
      }),
    ).toThrow();
  });
});
