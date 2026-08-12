import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  chatHistoryCursorSchema,
  chatHistoryRequestSchema,
  clientChatCommandSchema,
} from '../../src/modules/chat/chat.schemas.js';

describe('chat schemas', () => {
  const requestId = randomUUID();
  const eventId = randomUUID();

  it('accepts every command shape and trims message bodies', () => {
    expect(clientChatCommandSchema.parse({ type: 'chat.join', requestId, eventId })).toEqual({
      type: 'chat.join',
      requestId,
      eventId,
    });
    expect(clientChatCommandSchema.parse({ type: 'chat.leave', requestId })).toEqual({
      type: 'chat.leave',
      requestId,
    });
    expect(
      clientChatCommandSchema.parse({
        type: 'chat.message.send',
        requestId,
        eventId,
        clientMessageId: randomUUID(),
        body: '  hello  ',
      }),
    ).toMatchObject({ body: 'hello' });
    expect(
      clientChatCommandSchema.safeParse({
        type: 'chat.message.delete',
        requestId,
        eventId,
        messageId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      clientChatCommandSchema.safeParse({
        type: 'chat.typing.set',
        requestId,
        eventId,
        isTyping: true,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['unknown command', { type: 'chat.nope', requestId }],
    ['unknown property', { type: 'chat.leave', requestId, extra: true }],
    ['invalid UUID', { type: 'chat.join', requestId: 'bad', eventId }],
    [
      'empty body',
      {
        type: 'chat.message.send',
        requestId,
        eventId,
        clientMessageId: randomUUID(),
        body: '   ',
      },
    ],
    [
      'oversized body',
      {
        type: 'chat.message.send',
        requestId,
        eventId,
        clientMessageId: randomUUID(),
        body: 'x'.repeat(2_001),
      },
    ],
  ])('rejects %s', (_case, command) => {
    expect(clientChatCommandSchema.safeParse(command).success).toBe(false);
  });

  it('validates history input and the decoded cursor payload', () => {
    expect(
      chatHistoryRequestSchema.parse({ body: undefined, params: { eventId }, query: {} }),
    ).toMatchObject({ query: { limit: 50 } });
    expect(
      chatHistoryRequestSchema.safeParse({
        body: undefined,
        params: { eventId },
        query: { limit: 101 },
      }).success,
    ).toBe(false);
    expect(
      chatHistoryCursorSchema.safeParse({
        createdAt: '2026-08-12T12:00:00.000Z',
        id: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      chatHistoryCursorSchema.safeParse({
        createdAt: 'not-a-time',
        id: randomUUID(),
        extra: true,
      }).success,
    ).toBe(false);
  });
});
