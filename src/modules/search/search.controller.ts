import type { RequestHandler } from 'express';

import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { SearchEventsRequest, SuggestEventsRequest } from './search.schemas.js';
import type { SearchService } from './search.service.js';

export class SearchController {
  public constructor(private readonly service: SearchService) {}

  public readonly searchEvents: RequestHandler = async (_request, response) => {
    const { query } = getValidated<SearchEventsRequest>(response);
    const page = await this.service.searchEvents(query);
    response.json({
      data: page.items,
      pagination: { total: page.total, nextCursor: page.nextCursor },
      facets: page.facets,
    });
  };

  public readonly suggestEvents: RequestHandler = async (_request, response) => {
    const { query } = getValidated<SuggestEventsRequest>(response);
    response.json({ data: await this.service.suggestEvents(query.q, query.limit) });
  };
}
