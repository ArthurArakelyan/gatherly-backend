import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { chatHistoryCursorSchema } from './chat.schemas.js';
import type {
  ChatAccess,
  ChatHistoryCursor,
  ChatHistoryPage,
  ChatMessage,
  CommunityChatRole,
  DeleteMessageResult,
  SendMessageResult,
} from './chat.types.js';

interface AccessRow {
  event_id: string;
  user_id: string;
  username: string;
  role: CommunityChatRole;
}

interface MessageRow {
  id: string;
  event_id: string;
  sender_user_id: string;
  username: string;
  body: string;
  deleted_at: Date | null;
  created_at: Date;
}

const encodeChatCursor = (cursor: ChatHistoryCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeChatCursor = (value: string | undefined): ChatHistoryCursor | null => {
  if (value === undefined) return null;

  try {
    const parsedJson: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const parsed = chatHistoryCursorSchema.safeParse(parsedJson);
    if (!parsed.success || encodeChatCursor(parsed.data) !== value) throw new Error('bad cursor');
    return parsed.data;
  } catch {
    throw new AppError(400, 'INVALID_CHAT_CURSOR', 'Chat history cursor is invalid');
  }
};

const mapMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  eventId: row.event_id,
  sender: { id: row.sender_user_id, username: row.username },
  body: row.deleted_at === null ? row.body : null,
  deletedAt: row.deleted_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

const findAccess = async (
  client: Pool | PoolClient,
  eventId: string,
  userId: string,
  lock: boolean,
): Promise<ChatAccess | null> => {
  const result = await client.query<AccessRow>(
    `SELECT event_record.id AS event_id,
            account.id AS user_id,
            account.username,
            membership.role
     FROM events AS event_record
     JOIN communities AS community
       ON community.id = event_record.community_id
     JOIN community_memberships AS membership
       ON membership.community_id = community.id
      AND membership.user_id = $2::uuid
     JOIN users AS account
       ON account.id = membership.user_id
     WHERE event_record.id = $1::uuid
       AND event_record.status IN ('PUBLISHED', 'COMPLETED')
       AND community.status = 'ACTIVE'
       AND membership.status = 'ACTIVE'
       AND account.status = 'ACTIVE'
     ${lock ? 'FOR SHARE OF event_record, community, membership, account' : ''}`,
    [eventId, userId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        eventId: row.event_id,
        userId: row.user_id,
        username: row.username,
        role: row.role,
      };
};

const selectMessage = async (
  client: Pool | PoolClient,
  eventId: string,
  messageId: string,
): Promise<ChatMessage | null> => {
  const result = await client.query<MessageRow>(
    `SELECT message.id,
            conversation.event_id,
            message.sender_user_id,
            sender.username,
            message.body,
            message.deleted_at,
            message.created_at
     FROM chat_messages AS message
     JOIN event_conversations AS conversation
       ON conversation.id = message.conversation_id
     JOIN users AS sender ON sender.id = message.sender_user_id
     WHERE conversation.event_id = $1::uuid
       AND message.id = $2::uuid`,
    [eventId, messageId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapMessage(row);
};

export class ChatRepository {
  public constructor(private readonly pool: Pool) {}

  public async findActiveUsername(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ username: string }>(
      `SELECT username FROM users WHERE id = $1::uuid AND status = 'ACTIVE'`,
      [userId],
    );
    return result.rows[0]?.username ?? null;
  }

  public findAccess(eventId: string, userId: string): Promise<ChatAccess | null> {
    return findAccess(this.pool, eventId, userId, false);
  }

  public async findHistory(
    eventId: string,
    userId: string,
    encodedCursor: string | undefined,
    limit: number,
  ): Promise<ChatHistoryPage | null> {
    const cursor = decodeChatCursor(encodedCursor);
    return withTransaction(this.pool, async (client) => {
      if ((await findAccess(client, eventId, userId, true)) === null) return null;

      const result = await client.query<MessageRow>(
        `SELECT message.id,
                conversation.event_id,
                message.sender_user_id,
                sender.username,
                message.body,
                message.deleted_at,
                message.created_at
         FROM event_conversations AS conversation
         JOIN chat_messages AS message
           ON message.conversation_id = conversation.id
         JOIN users AS sender ON sender.id = message.sender_user_id
         WHERE conversation.event_id = $1::uuid
           AND (
             $2::timestamptz IS NULL
             OR (message.created_at, message.id) < ($2::timestamptz, $3::uuid)
           )
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT $4`,
        [eventId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      );

      const hasNextPage = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(mapMessage),
        nextCursor:
          hasNextPage && last !== undefined
            ? encodeChatCursor({ createdAt: last.created_at.toISOString(), id: last.id })
            : null,
      };
    });
  }

  public async createMessage(
    eventId: string,
    userId: string,
    clientMessageId: string,
    body: string,
  ): Promise<SendMessageResult | null> {
    return withTransaction(this.pool, async (client) => {
      if ((await findAccess(client, eventId, userId, true)) === null) return null;

      const conversationResult = await client.query<{ id: string }>(
        `INSERT INTO event_conversations (event_id)
         VALUES ($1::uuid)
         ON CONFLICT (event_id) DO UPDATE
           SET updated_at = event_conversations.updated_at
         RETURNING id`,
        [eventId],
      );
      const conversationId = conversationResult.rows[0]?.id;
      if (conversationId === undefined) throw new Error('Conversation upsert returned no row');

      const inserted = await client.query<MessageRow>(
        `INSERT INTO chat_messages (
           conversation_id, sender_user_id, client_message_id, body
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
         ON CONFLICT (conversation_id, sender_user_id, client_message_id) DO NOTHING
         RETURNING id,
                   $5::uuid AS event_id,
                   sender_user_id,
                   (SELECT username FROM users WHERE id = sender_user_id) AS username,
                   body,
                   deleted_at,
                   created_at`,
        [conversationId, userId, clientMessageId, body, eventId],
      );
      const created = inserted.rows[0];
      if (created !== undefined) return { message: mapMessage(created), duplicate: false };

      const existing = await client.query<MessageRow & { client_message_id: string }>(
        `SELECT message.id,
                $4::uuid AS event_id,
                message.sender_user_id,
                sender.username,
                message.body,
                message.deleted_at,
                message.created_at,
                message.client_message_id
         FROM chat_messages AS message
         JOIN users AS sender ON sender.id = message.sender_user_id
         WHERE message.conversation_id = $1::uuid
           AND message.sender_user_id = $2::uuid
           AND message.client_message_id = $3::uuid
         FOR UPDATE OF message`,
        [conversationId, userId, clientMessageId, eventId],
      );
      const duplicate = existing.rows[0];
      if (duplicate === undefined) throw new Error('Conflicting message disappeared');
      if (duplicate.body !== body) {
        throw new AppError(
          409,
          'CHAT_CLIENT_MESSAGE_ID_REUSED',
          'Client message ID was reused with different content',
        );
      }
      return { message: mapMessage(duplicate), duplicate: true };
    });
  }

  public async deleteMessage(
    eventId: string,
    messageId: string,
    actorUserId: string,
  ): Promise<DeleteMessageResult | 'FORBIDDEN' | null> {
    return withTransaction(this.pool, async (client) => {
      const access = await findAccess(client, eventId, actorUserId, true);
      if (access === null) return null;

      const result = await client.query<MessageRow>(
        `SELECT message.id,
                conversation.event_id,
                message.sender_user_id,
                sender.username,
                message.body,
                message.deleted_at,
                message.created_at
         FROM chat_messages AS message
         JOIN event_conversations AS conversation
           ON conversation.id = message.conversation_id
         JOIN users AS sender ON sender.id = message.sender_user_id
         WHERE conversation.event_id = $1::uuid
           AND message.id = $2::uuid
         FOR UPDATE OF message`,
        [eventId, messageId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;

      const privileged = ['MODERATOR', 'ORGANIZER', 'OWNER'].includes(access.role);
      if (row.sender_user_id !== actorUserId && !privileged) return 'FORBIDDEN';
      if (row.deleted_at !== null) return { message: mapMessage(row), changed: false };

      const updated = await client.query<MessageRow>(
        `UPDATE chat_messages AS message
         SET deleted_at = now(), deleted_by_user_id = $3::uuid
         FROM event_conversations AS conversation, users AS sender
         WHERE message.id = $2::uuid
           AND conversation.id = message.conversation_id
           AND conversation.event_id = $1::uuid
           AND sender.id = message.sender_user_id
         RETURNING message.id,
                   conversation.event_id,
                   message.sender_user_id,
                   sender.username,
                   message.body,
                   message.deleted_at,
                   message.created_at`,
        [eventId, messageId, actorUserId],
      );
      const deleted = updated.rows[0];
      if (deleted === undefined) throw new Error('Message deletion returned no row');

      await client.query(
        `INSERT INTO chat_moderation_actions (message_id, actor_user_id, action)
         VALUES ($1::uuid, $2::uuid, 'DELETE')`,
        [messageId, actorUserId],
      );
      return { message: mapMessage(deleted), changed: true };
    });
  }

  public findMessageForBroadcast(eventId: string, messageId: string): Promise<ChatMessage | null> {
    return selectMessage(this.pool, eventId, messageId);
  }
}
