import { z } from 'zod';

import type { RealtimeEvent } from './realtime.types.js';

const eventIdSchema = z.string().regex(/^\d+$/);

const notificationCreatedSchema = z.object({
  id: eventIdSchema,
  type: z.literal('notification.created'),
  data: z.object({
    notification: z.object({
      id: z.uuid(),
      type: z.string().min(1),
      title: z.string(),
      message: z.string(),
      data: z.record(z.string(), z.unknown()),
      readAt: z.null(),
      createdAt: z.iso.datetime(),
    }),
  }),
  createdAt: z.date(),
});

const attendanceUpdatedSchema = z.object({
  id: eventIdSchema,
  type: z.literal('event.attendance.updated'),
  data: z.object({
    eventId: z.uuid(),
    confirmedCount: z.number().int().nonnegative(),
    waitingCount: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
  }),
  createdAt: z.date(),
});

export const realtimeEventSchema: z.ZodType<RealtimeEvent> = z.discriminatedUnion('type', [
  notificationCreatedSchema,
  attendanceUpdatedSchema,
]);
