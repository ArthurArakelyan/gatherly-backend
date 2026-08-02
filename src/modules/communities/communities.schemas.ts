import { z } from 'zod';

import { paginationSchema } from '../../shared/validation/pagination.schema.js';

const uuid = z.uuid();

export const createCommunityRequestSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(3).max(100),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z.string().trim().max(2_000).default(''),
      city: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .transform((value) => value ?? null),
      country: z
        .string()
        .trim()
        .min(2)
        .max(100)
        .optional()
        .transform((value) => value ?? null),
    })
    .strict(),
  params: z.object({}),
  query: z.object({}),
});

export const listCommunitiesRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: paginationSchema,
});

export const getCommunityRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ communityId: uuid }),
  query: z.object({}),
});
