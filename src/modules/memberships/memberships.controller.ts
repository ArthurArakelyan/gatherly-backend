import type { RequestHandler } from 'express';

import { getRequestUserId } from '../../shared/http/request-user.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { MembershipsService } from './memberships.service.js';
import type { CommunityMembershipRequest } from './memberships.schemas.js';

export class MembershipsController {
  public constructor(private readonly service: MembershipsService) {}

  public readonly join: RequestHandler = async (_request, response) => {
    const { params } = getValidated<CommunityMembershipRequest>(response);
    const result = await this.service.join(params.communityId, getRequestUserId(response));
    response.status(result.created ? 201 : 200).json({ data: { status: result.status } });
  };

  public readonly leave: RequestHandler = async (_request, response) => {
    const { params } = getValidated<CommunityMembershipRequest>(response);
    await this.service.leave(params.communityId, getRequestUserId(response));
    response.status(204).send();
  };
}
