import { describe, expect, it, vi } from 'vitest';

import type { EventsRepository } from '../../src/modules/events/events.repository.js';
import { EventsService } from '../../src/modules/events/events.service.js';
import type { CreateEventInput, Event } from '../../src/modules/events/events.types.js';
import { createEventCacheMock } from '../helpers/event-cache.js';

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

const event: Event = {
  id: '10000000-0000-4000-8000-000000000001',
  communityId: '20000000-0000-4000-8000-000000000001',
  createdByUserId: '30000000-0000-4000-8000-000000000001',
  ...input,
  status: 'PUBLISHED',
  createdAt: new Date('2026-08-07T00:00:00.000Z'),
  updatedAt: new Date('2026-08-07T00:00:00.000Z'),
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

  it('returns a cached public event without querying PostgreSQL', async () => {
    const findPublicById = vi.fn();
    const repository = {
      create: vi.fn(),
      findCreationAuthorization: vi.fn(),
      findPublicById,
      listPublic: vi.fn(),
    } as unknown as EventsRepository;
    const cache = createEventCacheMock();
    cache.get.mockResolvedValue(event);
    const service = new EventsService(repository, cache);

    await expect(service.get(event.id)).resolves.toEqual(event);
    expect(findPublicById).not.toHaveBeenCalled();
    expect(cache.set.mock.calls).toHaveLength(0);
  });

  it('loads a cache miss from PostgreSQL and populates the cache', async () => {
    const findPublicById = vi.fn().mockResolvedValue(event);
    const repository = {
      create: vi.fn(),
      findCreationAuthorization: vi.fn(),
      findPublicById,
      listPublic: vi.fn(),
    } as unknown as EventsRepository;
    const cache = createEventCacheMock();
    const service = new EventsService(repository, cache);

    await expect(service.get(event.id)).resolves.toEqual(event);
    expect(findPublicById).toHaveBeenCalledWith(event.id);
    expect(cache.set.mock.calls).toEqual([[event]]);
  });
});
