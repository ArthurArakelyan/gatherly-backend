import { createHash } from 'node:crypto';

import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';
import type { EventSearchQuery } from './search.types.js';

const sortValueSchema = z.union([z.string(), z.number()]);

const searchCursorSchema = z
  .object({
    v: z.literal(1),
    pitId: z.string().min(1).max(4_096),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sort: z.array(sortValueSchema).min(2).max(4),
  })
  .strict();

export type SearchCursor = z.infer<typeof searchCursorSchema>;

export const fingerprintSearchQuery = (query: EventSearchQuery): string => {
  const canonical = JSON.stringify({
    q: query.q,
    communityId: query.communityId,
    format: query.format,
    city: query.city,
    country: query.country,
    startsAfter: query.startsAfter?.toISOString() ?? null,
    startsBefore: query.startsBefore?.toISOString() ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
};

export const encodeSearchCursor = (cursor: SearchCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeSearchCursor = (value: string): SearchCursor => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return searchCursorSchema.parse(decoded);
  } catch {
    throw new AppError(400, 'INVALID_SEARCH_CURSOR', 'The search cursor is invalid');
  }
};
