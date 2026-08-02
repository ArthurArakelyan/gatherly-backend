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
