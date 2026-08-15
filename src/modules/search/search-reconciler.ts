import type { Client, estypes } from '@elastic/elasticsearch';

import { EVENT_SEARCH_READ_ALIAS } from '../../infrastructure/elasticsearch/event-index-definition.js';
import type { EventSearchSourceRepository } from './event-search-source.repository.js';

interface IndexedVersion {
  id: string;
  updatedAt: string;
}

export interface SearchReconciliationResult {
  eligible: number;
  indexed: number;
  missing: number;
  stale: number;
  ineligible: number;
}

export class SearchReconciler {
  public constructor(
    private readonly source: EventSearchSourceRepository,
    private readonly elasticsearch: Client,
  ) {}

  public async reconcile(): Promise<SearchReconciliationResult> {
    const eligible = new Map<string, string>();
    for await (const document of this.source.iterateEligible()) {
      eligible.set(document.id, document.updatedAt);
    }

    const indexed = new Map<string, string>();
    let searchAfter: estypes.SortResults | undefined;

    for (;;) {
      const response = await this.elasticsearch.search<IndexedVersion>({
        index: EVENT_SEARCH_READ_ALIAS,
        size: 500,
        _source: ['id', 'updatedAt'],
        sort: [{ id: 'asc' }],
        ...(searchAfter === undefined ? {} : { search_after: searchAfter }),
      });

      for (const hit of response.hits.hits) {
        if (hit._source !== undefined) indexed.set(hit._source.id, hit._source.updatedAt);
      }

      const lastHit = response.hits.hits.at(-1);
      if (lastHit?.sort === undefined || response.hits.hits.length < 500) break;
      searchAfter = lastHit.sort;
    }

    let missing = 0;
    let stale = 0;
    for (const [eventId, updatedAt] of eligible) {
      const indexedVersion = indexed.get(eventId);
      if (indexedVersion === undefined) missing += 1;
      else if (indexedVersion !== updatedAt) stale += 1;
    }

    let ineligible = 0;
    for (const eventId of indexed.keys()) {
      if (!eligible.has(eventId)) ineligible += 1;
    }

    return {
      eligible: eligible.size,
      indexed: indexed.size,
      missing,
      stale,
      ineligible,
    };
  }
}
