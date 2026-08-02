import { z } from 'zod';

export const eventAttendanceRequestSchema = z.object({
  body: z.unknown(),
  params: z.object({ eventId: z.uuid() }),
  query: z.object({}),
});

export type EventAttendanceRequest = z.infer<typeof eventAttendanceRequestSchema>;
