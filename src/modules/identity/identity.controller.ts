import type { RequestHandler } from 'express';

import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { SignInRequest, SignUpRequest } from './identity.schemas.js';
import type { IdentityService } from './identity.service.js';
import type { AuthenticationResult, PublicUser } from './identity.types.js';
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';

const toPublicUserDto = (user: PublicUser) => ({
  id: user.id,
  username: user.username,
  status: user.status,
  platformRole: user.platformRole,
  createdAt: user.createdAt.toISOString(),
});

const toAuthenticationDto = (result: AuthenticationResult) => ({
  data: {
    user: {
      id: result.user.id,
      username: result.user.username,
      status: result.user.status,
      platformRole: result.user.platformRole,
      createdAt: result.user.createdAt.toISOString(),
    },
    accessToken: result.accessToken,
    tokenType: result.tokenType,
    expiresIn: result.expiresIn,
  },
});

export class IdentityController {
  public constructor(private readonly service: IdentityService) {}

  public readonly signUp: RequestHandler = async (_request, response) => {
    const { body } = getValidated<SignUpRequest>(response);
    response.status(201).json(toAuthenticationDto(await this.service.signUp(body)));
  };

  public readonly signIn: RequestHandler = async (_request, response) => {
    const { body } = getValidated<SignInRequest>(response);
    response.json(toAuthenticationDto(await this.service.signIn(body)));
  };

  public readonly me: RequestHandler = (_request, response) => {
    response.json({ data: { user: toPublicUserDto(getAuthenticatedUser(response)) } });
  };
}
