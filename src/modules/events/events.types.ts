export type EventFormat = 'IN_PERSON' | 'ONLINE' | 'HYBRID';
export type EventVisibility = 'PUBLIC' | 'COMMUNITY_ONLY' | 'INVITE_ONLY';
export type PublicEventStatus = 'PUBLISHED' | 'CANCELLED' | 'COMPLETED';

export interface CreateEventInput {
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  visibility: EventVisibility;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  capacity: number;
}

export interface Event {
  id: string;
  communityId: string;
  createdByUserId: string;
  title: string;
  slug: string;
  description: string;
  format: EventFormat;
  status: string;
  visibility: EventVisibility;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  capacity: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventFilters {
  communityId: string | null;
  status: PublicEventStatus | null;
  startsAfter: Date | null;
  startsBefore: Date | null;
  page: number;
  limit: number;
}

export interface EventPage {
  items: Event[];
  page: number;
  limit: number;
  total: number;
}

export interface EventCreationAuthorization {
  communityStatus: string;
  membershipStatus: string | null;
  role: string | null;
}
