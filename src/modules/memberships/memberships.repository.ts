import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import type { JoinPersistenceOutcome, LeavePersistenceOutcome } from './memberships.types.js';

const membershipSelection = {
  id: true,
  role: true,
  status: true,
} satisfies Prisma.CommunityMembershipSelect;

const isRetryableConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === 'P2034' || error.code === 'P2002');

export class MembershipsRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async joinOpenCommunity(
    communityId: string,
    userId: string,
  ): Promise<JoinPersistenceOutcome> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const community = await transaction.community.findFirst({
              where: { id: communityId, status: 'ACTIVE' },
              select: { joinPolicy: true },
            });

            if (community === null) return 'COMMUNITY_NOT_FOUND';
            if (community.joinPolicy !== 'OPEN') return 'JOIN_NOT_AVAILABLE';

            const membership = await transaction.communityMembership.findUnique({
              where: { communityId_userId: { communityId, userId } },
              select: membershipSelection,
            });

            if (membership?.status === 'BANNED' || membership?.status === 'SUSPENDED') {
              return 'BLOCKED';
            }
            if (membership?.status === 'ACTIVE') return 'ALREADY_ACTIVE';

            if (membership === null) {
              await transaction.communityMembership.create({
                data: { communityId, userId, role: 'MEMBER', status: 'ACTIVE' },
                select: { id: true },
              });
              return 'CREATED';
            }

            await transaction.communityMembership.update({
              where: { id: membership.id },
              data: { role: 'MEMBER', status: 'ACTIVE', joinedAt: new Date() },
              select: { id: true },
            });
            return 'REACTIVATED';
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 3 && isRetryableConflict(error)) continue;
        throw error;
      }
    }

    throw new Error('Membership join retry loop ended unexpectedly');
  }

  public leaveCommunity(communityId: string, userId: string): Promise<LeavePersistenceOutcome> {
    return this.leaveWithRetry(communityId, userId);
  }

  private async leaveWithRetry(
    communityId: string,
    userId: string,
  ): Promise<LeavePersistenceOutcome> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.communityMembership.findUnique({
              where: { communityId_userId: { communityId, userId } },
              select: membershipSelection,
            });

            if (membership?.status !== 'ACTIVE') return 'NOT_ACTIVE';
            if (membership.role === 'OWNER') return 'OWNER';

            await transaction.communityMembership.update({
              where: { id: membership.id },
              data: { status: 'LEFT' },
              select: { id: true },
            });
            return 'LEFT';
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 3 && isRetryableConflict(error)) continue;
        throw error;
      }
    }

    throw new Error('Membership leave retry loop ended unexpectedly');
  }
}
