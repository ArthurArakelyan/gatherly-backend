import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import type { Logger } from 'pino';

import { EVENT_SEARCH_READ_ALIAS } from '../../infrastructure/elasticsearch/event-index-definition.js';
import { AppError } from '../../shared/errors/app-error.js';
import { eventSearchDocumentSchema } from './event-search-document.schema.js';
import { decodeSearchCursor, encodeSearchCursor, fingerprintSearchQuery } from './search.cursor.js';
import type {
  EventSearchDocument,
  EventSearchFacets,
  EventSearchPage,
  EventSearchQuery,
  EventSuggestion,
  SearchFacetBucket,
} from './search.types.js';

interface TermsAggregation {
  buckets?: { key: string | number; doc_count: number }[];
}

const toFacetBuckets = (value: unknown): SearchFacetBucket[] => {
  const aggregate = value as TermsAggregation | undefined;
  return (aggregate?.buckets ?? []).map((bucket) => ({
    value: String(bucket.key),
    count: bucket.doc_count,
  }));
};

const totalHits = (value: number | estypes.SearchTotalHits | undefined): number => {
  if (value === undefined) return 0;
  return typeof value === 'number' ? value : value.value;
};

const mapSearchFailure = (error: unknown, usedCursor: boolean): never => {
  if (usedCursor && error instanceof errors.ResponseError && error.statusCode === 404) {
    throw new AppError(
      400,
      'SEARCH_CURSOR_EXPIRED',
      'The search cursor expired; start the search again',
    );
  }

  if (
    error instanceof errors.ConnectionError ||
    error instanceof errors.TimeoutError ||
    error instanceof errors.ResponseError
  ) {
    throw new AppError(503, 'SEARCH_UNAVAILABLE', 'Event discovery is temporarily unavailable');
  }

  throw error;
};

export class SearchRepository {
  public constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  public async searchEvents(query: EventSearchQuery): Promise<EventSearchPage> {
    const fingerprint = fingerprintSearchQuery(query);
    const cursor = query.after === null ? null : decodeSearchCursor(query.after);

    if (cursor !== null && cursor.fingerprint !== fingerprint) {
      throw new AppError(
        400,
        'SEARCH_CURSOR_MISMATCH',
        'The search cursor belongs to different filters',
      );
    }

    let pitId = cursor?.pitId;
    let openedPit = false;

    try {
      if (pitId === undefined) {
        pitId = (
          await this.client.openPointInTime({
            index: EVENT_SEARCH_READ_ALIAS,
            keep_alive: '1m',
          })
        ).id;
        openedPit = true;
      }

      const filters: estypes.QueryDslQueryContainer[] = [];
      if (query.communityId !== null) {
        filters.push({ term: { communityId: query.communityId } });
      }
      if (query.format !== null) filters.push({ term: { format: query.format } });
      if (query.city !== null) filters.push({ term: { communityCity: query.city } });
      if (query.country !== null) {
        filters.push({ term: { communityCountry: query.country } });
      }
      if (query.startsAfter !== null || query.startsBefore !== null) {
        filters.push({
          range: {
            startsAt: {
              ...(query.startsAfter === null ? {} : { gte: query.startsAfter.toISOString() }),
              ...(query.startsBefore === null ? {} : { lt: query.startsBefore.toISOString() }),
            },
          },
        });
      }

      const relevanceQuery: estypes.QueryDslQueryContainer =
        query.q === null
          ? { match_all: {} }
          : {
              multi_match: {
                query: query.q,
                fields: ['title^4', 'communityName^2', 'description'],
                type: 'best_fields',
                fuzziness: 'AUTO',
                prefix_length: 1,
              },
            };

      const sort: estypes.Sort =
        query.q === null
          ? [{ startsAt: 'asc' }, { id: 'asc' }]
          : [{ _score: { order: 'desc' } }, { startsAt: 'asc' }, { id: 'asc' }];

      const response = await this.client.search<EventSearchDocument>({
        size: query.limit + 1,
        track_total_hits: true,
        pit: { id: pitId, keep_alive: '1m' },
        query: { bool: { must: [relevanceQuery], filter: filters } },
        sort,
        ...(cursor === null ? {} : { search_after: cursor.sort }),
        aggs: {
          formats: { terms: { field: 'format', size: 10 } },
          cities: { terms: { field: 'communityCity', size: 25 } },
          countries: { terms: { field: 'communityCountry', size: 25 } },
        },
      });

      const parsedHits = response.hits.hits.map((hit) => {
        const parsed = eventSearchDocumentSchema.safeParse(hit._source);
        if (!parsed.success) {
          this.logger.error(
            { documentId: hit._id, issues: parsed.error.issues },
            'Elasticsearch returned an invalid event projection',
          );
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        if (hit.sort === undefined) {
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        return { event: parsed.data, score: hit._score ?? null, sort: hit.sort };
      });

      const hasNext = parsedHits.length > query.limit;
      const pageHits = parsedHits.slice(0, query.limit);
      const latestPitId = response.pit_id ?? pitId;
      const lastHit = pageHits.at(-1);

      let nextCursor: string | null = null;
      if (hasNext && lastHit !== undefined) {
        const parsedSort = lastHit.sort.map((value) => {
          if (typeof value === 'string' || typeof value === 'number') return value;
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        });
        nextCursor = encodeSearchCursor({
          v: 1,
          pitId: latestPitId,
          fingerprint,
          sort: parsedSort,
        });
      } else {
        await this.closePointInTime(latestPitId);
      }

      const facets: EventSearchFacets = {
        formats: toFacetBuckets(response.aggregations?.['formats']),
        cities: toFacetBuckets(response.aggregations?.['cities']),
        countries: toFacetBuckets(response.aggregations?.['countries']),
      };

      return {
        items: pageHits.map(({ event, score }) => ({ event, score })),
        total: totalHits(response.hits.total),
        nextCursor,
        facets,
      };
    } catch (error) {
      if (pitId !== undefined && openedPit) await this.closePointInTime(pitId);
      return mapSearchFailure(error, cursor !== null);
    }
  }

  public async suggestEvents(query: string, limit: number): Promise<EventSuggestion[]> {
    try {
      const response = await this.client.search<EventSearchDocument>({
        index: EVENT_SEARCH_READ_ALIAS,
        size: limit,
        _source: ['id', 'title', 'communityName', 'startsAt'],
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query,
                  type: 'bool_prefix',
                  fields: ['title', 'title._2gram', 'title._3gram'],
                },
              },
            ],
            filter: [{ range: { startsAt: { gte: 'now' } } }],
          },
        },
        sort: [{ _score: { order: 'desc' } }, { startsAt: 'asc' }, { id: 'asc' }],
      });

      return response.hits.hits.map((hit) => {
        const parsed = eventSearchDocumentSchema
          .pick({ id: true, title: true, communityName: true, startsAt: true })
          .safeParse(hit._source);
        if (!parsed.success) {
          this.logger.error(
            { documentId: hit._id, issues: parsed.error.issues },
            'Elasticsearch returned an invalid event suggestion',
          );
          throw new AppError(
            503,
            'SEARCH_INDEX_INVALID',
            'Event discovery is temporarily unavailable',
          );
        }
        return parsed.data;
      });
    } catch (error) {
      return mapSearchFailure(error, false);
    }
  }

  private async closePointInTime(id: string): Promise<void> {
    try {
      await this.client.closePointInTime({ id });
    } catch (error) {
      this.logger.debug({ err: error }, 'Could not close Elasticsearch point in time');
    }
  }
}
