import { z } from 'zod';

import type { RedisCache } from '../../infrastructure/redis/cache.js';
import type { Event } from './events.types.js';

export interface EventCache {
  get(eventId: string): Promise<Event | null>;
  set(event: Event): Promise<void>;
  delete(eventId: string): Promise<void>;
}

const cachedEventSchema = z.object({
  id: z.uuid(),
  communityId: z.uuid(),
  createdByUserId: z.uuid(),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']),
  status: z.string(),
  visibility: z.enum(['PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY']),
  startsAt: z.iso.datetime().transform((value) => new Date(value)),
  endsAt: z.iso.datetime().transform((value) => new Date(value)),
  timezone: z.string(),
  capacity: z.number().int().positive(),
  createdAt: z.iso.datetime().transform((value) => new Date(value)),
  updatedAt: z.iso.datetime().transform((value) => new Date(value)),
});

const keyFor = (eventId: string): string => `gatherly:v1:event:${eventId}`;

export const createEventCache = (cache: RedisCache, ttlSeconds: number): EventCache => ({
  get: (eventId) => cache.get(keyFor(eventId), cachedEventSchema),
  set: (event) => cache.set(keyFor(event.id), event, ttlSeconds),
  delete: (eventId) => cache.delete(keyFor(eventId)),
});
