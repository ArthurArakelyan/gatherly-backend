import { type z } from 'zod';
import type { CommunitiesService } from './communities.service.js';
import type { RequestHandler } from 'express';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import {
  type createCommunityRequestSchema,
  type getCommunityRequestSchema,
  type listCommunitiesRequestSchema,
} from './communities.schemas.js';
import type { Community } from './communities.types.js';
import { getRequestUserId } from '../../shared/http/request-user.middleware.js';

interface CommunityDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  city: string | null;
  country: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

const toCommunityDto = (community: Community): CommunityDto => ({
  id: community.id,
  name: community.name,
  slug: community.slug,
  description: community.description,
  city: community.city,
  country: community.country,
  createdByUserId: community.createdByUserId,
  createdAt: community.createdAt.toISOString(),
  updatedAt: community.updatedAt.toISOString(),
});

export class CommunitiesController {
  public constructor(private readonly service: CommunitiesService) {}

  public readonly create: RequestHandler = async (_request, response) => {
    const { body } = getValidated<z.infer<typeof createCommunityRequestSchema>>(response);
    const community = await this.service.create(getRequestUserId(response), body);
    response.status(201).json({ data: toCommunityDto(community) });
  };

  public readonly list: RequestHandler = async (_request, response) => {
    const { query } = getValidated<z.infer<typeof listCommunitiesRequestSchema>>(response);
    const page = await this.service.list(query.page, query.limit);
    response.json({
      data: page.items.map(toCommunityDto),
      pagination: { page: page.page, limit: page.limit, total: page.total },
    });
  };

  public readonly get: RequestHandler = async (_request, response) => {
    const { params } = getValidated<z.infer<typeof getCommunityRequestSchema>>(response);
    response.json({ data: toCommunityDto(await this.service.get(params.communityId)) });
  };
}
