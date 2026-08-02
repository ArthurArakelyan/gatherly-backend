import { describe, expect, it, vi } from 'vitest';

import type { EventsRepository } from '../../src/modules/events/events.repository.js';
import { EventsService } from '../../src/modules/events/events.service.js';
import type { CreateEventInput } from '../../src/modules/events/events.types.js';

const input: CreateEventInput = {
  title: 'Board games',
  slug: 'board-games',
  description: '',
  format: 'IN_PERSON',
  visibility: 'PUBLIC',
  startsAt: new Date('2030-08-03T18:00:00.000Z'),
  endsAt: new Date('2030-08-03T21:00:00.000Z'),
  timezone: 'Europe/Moscow',
  capacity: 10,
};

describe('EventsService', () => {
  it('rejects an unauthorized event creator before persistence', async () => {
    const create = vi.fn();
    const findCreationAuthorization = vi.fn().mockResolvedValue({
      communityStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
      role: 'MEMBER',
    });
    const repository = {
      create,
      findCreationAuthorization,
      findPublicById: vi.fn(),
      listPublic: vi.fn(),
    } as unknown as EventsRepository;

    await expect(
      new EventsService(repository).create('community-id', 'user-id', input),
    ).rejects.toMatchObject({
      status: 403,
      code: 'COMMUNITY_PERMISSION_DENIED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an end instant that is not after the start instant', async () => {
    const findCreationAuthorization = vi.fn().mockResolvedValue({
      communityStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
      role: 'OWNER',
    });
    const repository = {
      create: vi.fn(),
      findCreationAuthorization,
      findPublicById: vi.fn(),
      listPublic: vi.fn(),
    } as unknown as EventsRepository;

    await expect(
      new EventsService(repository).create('community-id', 'user-id', {
        ...input,
        endsAt: input.startsAt,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_EVENT_TIME' });
  });
});
