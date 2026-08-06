import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  AuthenticatedUser,
  CredentialUser,
  PlatformRole,
  PublicUser,
  UserStatus,
} from './identity.types.js';

const publicUserSelection = {
  id: true,
  username: true,
  status: true,
  platformRole: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const mapPublicUser = (record: {
  id: string;
  username: string;
  status: string;
  platformRole: string;
  createdAt: Date;
}): PublicUser => ({
  ...record,
  status: record.status as UserStatus,
  platformRole: record.platformRole as PlatformRole,
});

export class IdentityRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(username: string, passwordHash: string): Promise<PublicUser> {
    try {
      const user = await this.prisma.user.create({
        data: { username, passwordHash },
        select: publicUserSelection,
      });
      return mapPublicUser(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(409, 'USERNAME_TAKEN', 'That username is unavailable');
      }
      throw error;
    }
  }

  public async findCredentialsByUsername(username: string): Promise<CredentialUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { ...publicUserSelection, passwordHash: true },
    });
    return user === null ? null : { ...mapPublicUser(user), passwordHash: user.passwordHash };
  }

  public async findAuthenticatedById(userId: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: publicUserSelection,
    });
    if (user?.status !== 'ACTIVE') return null;
    return mapPublicUser(user);
  }

  public async recordSuccessfulLogin(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
      select: { id: true },
    });
  }
}
