import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import type { Community, CommunityPage, CreateCommunityInput } from './communities.types.js';

const selection = {
  id: true,
  name: true,
  slug: true,
  description: true,
  city: true,
  country: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CommunitySelect;

type CommunityRecord = Prisma.CommunityGetPayload<{ select: typeof selection }>;

const mapCommunity = (record: CommunityRecord): Community => ({
  id: record.id,
  name: record.name,
  slug: record.slug,
  description: record.description,
  city: record.city,
  country: record.country,
  createdByUserId: record.createdByUserId,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export class CommunitiesRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createWithOwner(userId: string, input: CreateCommunityInput): Promise<Community> {
    try {
      const record = await this.prisma.$transaction(async (transaction) => {
        const community = await transaction.community.create({
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description,
            city: input.city,
            country: input.country,
            createdByUserId: userId,
          },
          select: selection,
        });
        await transaction.communityMembership.create({
          data: { communityId: community.id, userId, role: 'OWNER', status: 'ACTIVE' },
        });
        return community;
      });
      return mapCommunity(record);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'COMMUNITY_SLUG_TAKEN', 'That community slug is already used');
      }
      throw error;
    }
  }

  public async findById(id: string): Promise<Community | null> {
    const record = await this.prisma.community.findFirst({
      where: { id, status: 'ACTIVE' },
      select: selection,
    });
    return record === null ? null : mapCommunity(record);
  }

  public async list(page: number, limit: number): Promise<CommunityPage> {
    const where = { status: 'ACTIVE', visibility: 'PUBLIC' };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.community.findMany({
        where,
        select: selection,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.community.count({ where }),
    ]);
    return { items: records.map(mapCommunity), page, limit, total };
  }
}
