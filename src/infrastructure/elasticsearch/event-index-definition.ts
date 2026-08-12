export const EVENT_SEARCH_READ_ALIAS = 'gatherly-events-read';
export const EVENT_SEARCH_WRITE_ALIAS = 'gatherly-events-write';

export const createEventIndexName = (prefix: string, now = new Date()): string =>
  `${prefix}-v${now.toISOString().replace(/[^0-9]/g, '')}`;

export const eventIndexDefinition = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '1s',
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      communityId: { type: 'keyword' },
      communityName: { type: 'text' },
      communitySlug: { type: 'keyword' },
      communityCity: { type: 'keyword' },
      communityCountry: { type: 'keyword' },
      title: { type: 'search_as_you_type', max_shingle_size: 3 },
      description: { type: 'text' },
      format: { type: 'keyword' },
      startsAt: { type: 'date' },
      endsAt: { type: 'date' },
      timezone: { type: 'keyword' },
      updatedAt: { type: 'date' },
    },
  },
} as const;
