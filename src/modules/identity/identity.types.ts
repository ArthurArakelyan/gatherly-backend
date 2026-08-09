import type { RequestHandler } from 'express';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type PlatformRole = 'USER' | 'PLATFORM_MODERATOR' | 'PLATFORM_ADMIN';

export interface PublicUser {
  id: string;
  username: string;
  status: UserStatus;
  platformRole: PlatformRole;
  createdAt: Date;
}

export interface CredentialUser extends PublicUser {
  passwordHash: string;
}

export type AuthenticatedUser = PublicUser;

export interface SignUpInput {
  username: string;
  password: string;
}

export interface SignInInput {
  username: string;
  password: string;
}

export interface AuthenticationResult {
  user: PublicUser;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface IdentityRateLimiters {
  signUp: RequestHandler;
  signIn: RequestHandler;
}
