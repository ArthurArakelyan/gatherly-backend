import { describe, expect, it, vi } from 'vitest';

import type { CommunitiesRepository } from '../../src/modules/communities/communities.repository.js';
import { CommunitiesService } from '../../src/modules/communities/communities.service.js';

describe('CommunitiesService', () => {
  it('turns a missing repository result into COMMUNITY_NOT_FOUND', async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const repository = {
      createWithOwner: vi.fn(),
      findById,
      list: vi.fn(),
    } as unknown as CommunitiesRepository;

    await expect(new CommunitiesService(repository).get('community-id')).rejects.toMatchObject({
      status: 404,
      code: 'COMMUNITY_NOT_FOUND',
    });
  });
});
