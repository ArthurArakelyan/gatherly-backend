import type { MembershipsRepository } from './memberships.repository.js';
import type { JoinMembershipResult } from './memberships.types.js';
import { AppError } from '../../shared/errors/app-error.js';

export class MembershipsService {
  public constructor(private readonly repository: MembershipsRepository) {}

  public async join(communityId: string, userId: string): Promise<JoinMembershipResult> {
    const outcome = await this.repository.joinOpenCommunity(communityId, userId);

    switch (outcome) {
      case 'COMMUNITY_NOT_FOUND':
        throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'The requested community does not exist');
      case 'JOIN_NOT_AVAILABLE':
        throw new AppError(409, 'JOIN_NOT_AVAILABLE', 'This community cannot be joined directly');
      case 'BLOCKED':
        throw new AppError(403, 'COMMUNITY_ACCESS_DENIED', 'Community access is denied');
      case 'ALREADY_ACTIVE':
        return { created: false, status: 'ACTIVE' };
      case 'CREATED':
      case 'REACTIVATED':
        return { created: true, status: 'ACTIVE' };
    }
  }

  public async leave(communityId: string, userId: string): Promise<void> {
    const outcome = await this.repository.leaveCommunity(communityId, userId);

    switch (outcome) {
      case 'NOT_ACTIVE':
        throw new AppError(404, 'MEMBERSHIP_NOT_FOUND', 'No active membership exists');
      case 'OWNER':
        throw new AppError(409, 'OWNER_CANNOT_LEAVE', 'Transfer ownership before leaving');
      case 'LEFT':
        return;
    }
  }
}
