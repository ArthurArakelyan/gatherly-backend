export type SearchableEventFormat = 'IN_PERSON' | 'ONLINE' | 'HYBRID';

export interface EventSearchDocument {
  id: string;
  communityId: string;
  communityName: string;
  communitySlug: string;
  communityCity: string | null;
  communityCountry: string | null;
  title: string;
  description: string;
  format: SearchableEventFormat;
  startsAt: string;
  endsAt: string;
  timezone: string;
  updatedAt: string;
}

export interface EventSearchQuery {
  q: string | null;
  communityId: string | null;
  format: SearchableEventFormat | null;
  city: string | null;
  country: string | null;
  startsAfter: Date | null;
  startsBefore: Date | null;
  after: string | null;
  limit: number;
}

export interface EventSearchHit {
  event: EventSearchDocument;
  score: number | null;
}

export interface SearchFacetBucket {
  value: string;
  count: number;
}

export interface EventSearchFacets {
  formats: SearchFacetBucket[];
  cities: SearchFacetBucket[];
  countries: SearchFacetBucket[];
}

export interface EventSearchPage {
  items: EventSearchHit[];
  total: number;
  nextCursor: string | null;
  facets: EventSearchFacets;
}

export interface EventSuggestion {
  id: string;
  title: string;
  communityName: string;
  startsAt: string;
}
