import { describe, expect, it } from 'vitest';

import { Argon2PasswordHasher } from '../../src/infrastructure/security/argon2-password-hasher.js';
import { JwtAccessTokens } from '../../src/infrastructure/security/jwt-access-tokens.js';

describe('security adapters', () => {
  it('hashes and verifies passwords without accepting a locked or malformed marker', async () => {
    const hasher = new Argon2PasswordHasher();
    const hash = await hasher.hash('GatherlyTest123');

    await expect(hasher.verify(hash, 'GatherlyTest123')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'incorrect-password')).resolves.toBe(false);
    await expect(hasher.verify('locked:unrecognizable-marker', 'GatherlyTest123')).resolves.toBe(
      false,
    );
  });

  it('round-trips a valid JWT and rejects tokens signed for another audience', () => {
    const tokens = new JwtAccessTokens({
      secret: 'test-only-jwt-secret-that-is-long-enough',
      issuer: 'gatherly-test-api',
      audience: 'gatherly-test-client',
      ttlSeconds: 900,
    });
    const wrongAudience = new JwtAccessTokens({
      secret: 'test-only-jwt-secret-that-is-long-enough',
      issuer: 'gatherly-test-api',
      audience: 'another-client',
      ttlSeconds: 900,
    });
    const userId = '00000000-0000-4000-8000-000000000001';

    expect(tokens.verify(tokens.sign(userId))).toBe(userId);
    expect(() => tokens.verify(wrongAudience.sign(userId))).toThrow(
      expect.objectContaining({ status: 401, code: 'AUTHENTICATION_REQUIRED' }),
    );
  });
});
