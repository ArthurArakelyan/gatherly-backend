import { AppError } from '../../shared/errors/app-error.js';
import type { IdentityRepository } from './identity.repository.js';
import type {
  AuthenticatedUser,
  AuthenticationResult,
  PublicUser,
  SignInInput,
  SignUpInput,
} from './identity.types.js';

interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

interface AccessTokens {
  sign(userId: string): string;
  verify(token: string): string;
}

// This is a valid hash for an irrelevant password. It is public on purpose and
// exists only to make an unknown username perform one Argon2 verification.
const dummyPasswordHash =
  '$argon2id$v=19$m=19456,p=1,t=2$NRVdMqrctPeU3C/oSliwcg$' +
  'SnjAx/RqJtCJioymG850l8ukZGfBJ0f+PYt4zGvIFII';

export class IdentityService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokens,
    private readonly accessTokenTtlSeconds: number,
  ) {}

  private createResult(user: PublicUser): AuthenticationResult {
    return {
      user,
      accessToken: this.accessTokens.sign(user.id),
      tokenType: 'Bearer',
      expiresIn: this.accessTokenTtlSeconds,
    };
  }

  public async signUp(input: SignUpInput): Promise<AuthenticationResult> {
    const passwordHash = await this.passwordHasher.hash(input.password);
    const user = await this.repository.create(input.username, passwordHash);
    return this.createResult(user);
  }

  public async signIn(input: SignInInput): Promise<AuthenticationResult> {
    const user = await this.repository.findCredentialsByUsername(input.username);
    const passwordMatches = await this.passwordHasher.verify(
      user?.passwordHash ?? dummyPasswordHash,
      input.password,
    );

    if (user === null || !passwordMatches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect');
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account cannot sign in');
    }

    await this.repository.recordSuccessfulLogin(user.id);
    const publicUser: PublicUser = {
      id: user.id,
      username: user.username,
      status: user.status,
      platformRole: user.platformRole,
      createdAt: user.createdAt,
    };
    return this.createResult(publicUser);
  }

  public async authenticateAccessToken(token: string): Promise<AuthenticatedUser> {
    const userId = this.accessTokens.verify(token);
    const user = await this.repository.findAuthenticatedById(userId);
    if (user === null) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }
    return user;
  }
}
