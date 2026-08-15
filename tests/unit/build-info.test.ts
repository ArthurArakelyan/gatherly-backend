import { describe, expect, it } from 'vitest';

import { createBuildInfo } from '../../src/config/build-info.js';

describe('createBuildInfo', () => {
  it('selects only safe deployment metadata', () => {
    expect(
      createBuildInfo({
        DEPLOYMENT_ENVIRONMENT: 'production',
        DEPLOYMENT_SLOT: 'green',
        APP_REVISION: '0123456789abcdef0123456789abcdef01234567',
        APP_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        DATABASE_URL: 'postgresql://secret',
        JWT_SECRET: 'do-not-return',
      }),
    ).toEqual({
      environment: 'production',
      slot: 'green',
      revision: '0123456789abcdef0123456789abcdef01234567',
      imageDigest: `sha256:${'a'.repeat(64)}`,
    });
  });

  it('omits an absent digest and supplies local defaults', () => {
    expect(createBuildInfo({})).toEqual({
      environment: 'development',
      revision: 'development',
      slot: 'local',
    });
  });
});
