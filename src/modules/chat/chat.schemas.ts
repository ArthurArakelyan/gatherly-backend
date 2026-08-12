import { z } from 'zod';

import type { ChatHistoryCursor, ClientChatCommand } from './chat.types.js';

const requestId = z.uuid();
const eventId = z.uuid();

export const chatHistoryCursorSchema: z.ZodType<ChatHistoryCursor> = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

export const clientChatCommandSchema: z.ZodType<ClientChatCommand> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('chat.join'), requestId, eventId }),
  z.strictObject({ type: z.literal('chat.leave'), requestId }),
  z.strictObject({
    type: z.literal('chat.message.send'),
    requestId,
    eventId,
    clientMessageId: z.uuid(),
    body: z.string().trim().min(1).max(2_000),
  }),
  z.strictObject({
    type: z.literal('chat.message.delete'),
    requestId,
    eventId,
    messageId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('chat.typing.set'),
    requestId,
    eventId,
    isTyping: z.boolean(),
  }),
]);

export const chatHistoryRequestSchema = z.object({
  body: z.unknown(),
  params: z.strictObject({ eventId }),
  query: z.strictObject({
    cursor: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

export type ChatHistoryRequest = z.infer<typeof chatHistoryRequestSchema>;
