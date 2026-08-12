import { z } from 'zod';

export const eventSearchDocumentSchema = z
  .object({
    id: z.uuid(),
    communityId: z.uuid(),
    communityName: z.string().min(1).max(200),
    communitySlug: z.string().min(1).max(200),
    communityCity: z.string().min(1).max(200).nullable(),
    communityCountry: z.string().min(1).max(200).nullable(),
    title: z.string().min(1).max(150),
    description: z.string().max(10_000),
    format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    timezone: z.string().min(1).max(100),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
