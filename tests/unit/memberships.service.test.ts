import { describe, expect, it, vi } from 'vitest';

import type { MembershipsRepository } from '../../src/modules/memberships/memberships.repository.js';
import { MembershipsService } from '../../src/modules/memberships/memberships.service.js';

describe('MembershipsService', () => {
  it('treats an already active membership as a successful no-op', async () => {
    const joinOpenCommunity = vi.fn().mockResolvedValue('ALREADY_ACTIVE');
    const repository = {
      joinOpenCommunity,
      leaveCommunity: vi.fn(),
    } as unknown as MembershipsRepository;

    await expect(
      new MembershipsService(repository).join('community-id', 'user-id'),
    ).resolves.toEqual({
      created: false,
      status: 'ACTIVE',
    });
  });

  it('prevents an owner from leaving through the service boundary', async () => {
    const leaveCommunity = vi.fn().mockResolvedValue('OWNER');
    const repository = {
      joinOpenCommunity: vi.fn(),
      leaveCommunity,
    } as unknown as MembershipsRepository;

    await expect(
      new MembershipsService(repository).leave('community-id', 'user-id'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'OWNER_CANNOT_LEAVE',
    });
  });
});
