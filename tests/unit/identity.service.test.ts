import { describe, expect, it, vi } from 'vitest';

import type { IdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import type { CredentialUser, PublicUser } from '../../src/modules/identity/identity.types.js';

const activeUser: PublicUser = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice',
  status: 'ACTIVE',
  platformRole: 'USER',
  createdAt: new Date('2026-08-06T00:00:00.000Z'),
};

const createSubject = (overrides?: {
  createdUser?: PublicUser;
  credentialUser?: CredentialUser | null;
  authenticatedUser?: PublicUser | null;
  passwordMatches?: boolean;
  sign?: (userId: string) => string;
  verifyToken?: (token: string) => string;
}) => {
  const createUser = vi.fn().mockResolvedValue(overrides?.createdUser);
  const findCredentials = vi.fn().mockResolvedValue(overrides?.credentialUser);
  const findAuthenticatedUser = vi.fn().mockResolvedValue(overrides?.authenticatedUser);
  const recordSuccessfulLogin = vi.fn().mockResolvedValue(undefined);
  const repository = {
    create: createUser,
    findCredentialsByUsername: findCredentials,
    findAuthenticatedById: findAuthenticatedUser,
    recordSuccessfulLogin,
  } as unknown as IdentityRepository;
  const hashPassword = vi.fn().mockResolvedValue('password-hash');
  const verifyPassword = vi.fn().mockResolvedValue(overrides?.passwordMatches ?? true);
  const passwordHasher = {
    hash: hashPassword,
    verify: verifyPassword,
  };
  const signToken = vi.fn(overrides?.sign ?? ((userId: string) => `token-for-${userId}`));
  const verifyToken = vi.fn(overrides?.verifyToken ?? (() => activeUser.id));
  const accessTokens = {
    sign: signToken,
    verify: verifyToken,
  };

  return {
    spies: {
      createUser,
      findCredentials,
      findAuthenticatedUser,
      recordSuccessfulLogin,
      hashPassword,
      verifyPassword,
      signToken,
      verifyToken,
    },
    service: new IdentityService(repository, passwordHasher, accessTokens, 900),
  };
};

describe('IdentityService', () => {
  it('hashes a password, creates the user, and returns an access token on sign-up', async () => {
    const subject = createSubject({ createdUser: activeUser });

    await expect(
      subject.service.signUp({ username: 'alice', password: 'strong-password' }),
    ).resolves.toEqual({
      user: activeUser,
      accessToken: `token-for-${activeUser.id}`,
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    expect(subject.spies.hashPassword).toHaveBeenCalledWith('strong-password');
    expect(subject.spies.createUser).toHaveBeenCalledWith('alice', 'password-hash');
  });

  it('verifies credentials and records a successful sign-in', async () => {
    const credentialUser: CredentialUser = { ...activeUser, passwordHash: 'stored-hash' };
    const subject = createSubject({ credentialUser });

    const result = await subject.service.signIn({ username: 'alice', password: 'password' });

    expect(result.user).toEqual(activeUser);
    expect(subject.spies.verifyPassword).toHaveBeenCalledWith('stored-hash', 'password');
    expect(subject.spies.recordSuccessfulLogin).toHaveBeenCalledWith(activeUser.id);
  });

  it('uses the same safe error for an unknown username and an incorrect password', async () => {
    const unknown = createSubject({ credentialUser: null, passwordMatches: false });
    const incorrect = createSubject({
      credentialUser: { ...activeUser, passwordHash: 'stored-hash' },
      passwordMatches: false,
    });

    await expect(
      unknown.service.signIn({ username: 'missing', password: 'password' }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    await expect(
      incorrect.service.signIn({ username: 'alice', password: 'wrong-password' }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(unknown.spies.verifyPassword).toHaveBeenCalledOnce();
  });

  it('rejects an inactive account after verifying its password', async () => {
    const subject = createSubject({
      credentialUser: {
        ...activeUser,
        status: 'SUSPENDED',
        passwordHash: 'stored-hash',
      },
    });

    await expect(
      subject.service.signIn({ username: 'alice', password: 'password' }),
    ).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_INACTIVE' });
    expect(subject.spies.recordSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('loads the current active user identified by a verified access token', async () => {
    const subject = createSubject({ authenticatedUser: activeUser });

    await expect(subject.service.authenticateAccessToken('access-token')).resolves.toEqual(
      activeUser,
    );
    expect(subject.spies.verifyToken).toHaveBeenCalledWith('access-token');
    expect(subject.spies.findAuthenticatedUser).toHaveBeenCalledWith(activeUser.id);
  });

  it('rejects a token whose user no longer exists or is active', async () => {
    const subject = createSubject({ authenticatedUser: null });

    await expect(subject.service.authenticateAccessToken('access-token')).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
  });
});
