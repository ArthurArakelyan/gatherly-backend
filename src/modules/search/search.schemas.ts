import { z } from 'zod';

const optionalInstantSchema = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value === undefined ? null : new Date(value)));

const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .optional()
    .transform((value) => value ?? null);

export const searchEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: z
    .object({
      q: optionalText(100),
      communityId: z
        .uuid()
        .optional()
        .transform((value) => value ?? null),
      format: z
        .enum(['IN_PERSON', 'ONLINE', 'HYBRID'])
        .optional()
        .transform((value) => value ?? null),
      city: optionalText(100),
      country: optionalText(100),
      startsAfter: optionalInstantSchema,
      startsBefore: optionalInstantSchema,
      after: z
        .string()
        .min(1)
        .max(8_192)
        .optional()
        .transform((value) => value ?? null),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict()
    .refine(
      (query) =>
        query.startsAfter === null ||
        query.startsBefore === null ||
        query.startsAfter < query.startsBefore,
      { path: ['startsBefore'], message: 'startsBefore must be after startsAfter' },
    ),
});

export const suggestEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: z
    .object({
      q: z.string().trim().min(2).max(80),
      limit: z.coerce.number().int().min(1).max(10).default(8),
    })
    .strict(),
});

export type SearchEventsRequest = z.infer<typeof searchEventsRequestSchema>;
export type SuggestEventsRequest = z.infer<typeof suggestEventsRequestSchema>;
