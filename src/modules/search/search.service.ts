import type { SearchRepository } from './search.repository.js';
import type { EventSearchPage, EventSearchQuery, EventSuggestion } from './search.types.js';

export class SearchService {
  public constructor(private readonly repository: SearchRepository) {}

  public searchEvents(query: EventSearchQuery): Promise<EventSearchPage> {
    return this.repository.searchEvents(query);
  }

  public suggestEvents(query: string, limit: number): Promise<EventSuggestion[]> {
    return this.repository.suggestEvents(query, limit);
  }
}
