export interface CreateCommunityInput {
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
}

export interface Community {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityPage {
  items: Community[];
  page: number;
  limit: number;
  total: number;
}

export type JoinPersistenceOutcome =
  | 'COMMUNITY_NOT_FOUND'
  | 'JOIN_NOT_AVAILABLE'
  | 'BLOCKED'
  | 'ALREADY_ACTIVE'
  | 'CREATED'
  | 'REACTIVATED';

export type LeavePersistenceOutcome = 'NOT_ACTIVE' | 'OWNER' | 'LEFT';

export interface JoinMembershipResult {
  created: boolean;
  status: 'ACTIVE';
}
