import { z } from 'zod';

import { paginationSchema } from '../../shared/validation/pagination.schema.js';

const instantSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const optionalInstantSchema = z.iso
  .datetime({ offset: true })
  .optional()
  .transform((value) => (value === undefined ? null : new Date(value)));

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA time-zone identifier');

const eventBodySchema = z
  .object({
    title: z.string().trim().min(3).max(150),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(10_000).default(''),
    format: z.enum(['IN_PERSON', 'ONLINE', 'HYBRID']).default('IN_PERSON'),
    visibility: z.enum(['PUBLIC', 'COMMUNITY_ONLY', 'INVITE_ONLY']).default('PUBLIC'),
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: timezoneSchema,
    capacity: z.number().int().positive(),
  })
  .strict()
  .refine((body) => body.startsAt < body.endsAt, {
    path: ['endsAt'],
    message: 'endsAt must be later than startsAt',
  });

export const createEventRequestSchema = z.object({
  body: eventBodySchema,
  params: z.object({ communityId: z.uuid() }),
  query: z.object({}),
});

export const listEventsRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({}),
  query: paginationSchema
    .extend({
      communityId: z
        .uuid()
        .optional()
        .transform((value) => value ?? null),
      status: z
        .enum(['PUBLISHED', 'CANCELLED', 'COMPLETED'])
        .optional()
        .transform((value) => value ?? null),
      startsAfter: optionalInstantSchema,
      startsBefore: optionalInstantSchema,
    })
    .refine(
      (query) =>
        query.startsAfter === null ||
        query.startsBefore === null ||
        query.startsAfter < query.startsBefore,
      { path: ['startsBefore'], message: 'startsBefore must be after startsAfter' },
    ),
});

export const getEventRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ eventId: z.uuid() }),
  query: z.object({}),
});

export type CreateEventRequest = z.infer<typeof createEventRequestSchema>;
export type ListEventsRequest = z.infer<typeof listEventsRequestSchema>;
export type GetEventRequest = z.infer<typeof getEventRequestSchema>;
