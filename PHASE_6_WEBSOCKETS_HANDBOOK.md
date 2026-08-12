# Phase 6 Handbook: WebSockets and Persisted Event Chat

This is the third Phase 6 implementation guide. It starts from the repository
after `PHASE_6_SSE_HANDBOOK.md` and adds WebSockets for one concrete
bidirectional Gatherly use: chat attached to an event.

The result remains one TypeScript/Node.js modular monolith and one deployment.
PostgreSQL owns conversations, messages, idempotency, soft deletion, and the
moderation audit trail. WebSockets carry commands and live results. Redis
provides short-lived handshake tickets, cross-instance fan-out, typing, and
presence leases. Losing Redis may interrupt new WebSocket handshakes and make
ephemeral state incomplete, but it never deletes a message or changes who is
allowed to read an event chat.

This handbook deliberately stops before private messages, attachments, edits,
reactions, threads, read receipts, reports, bans, Elasticsearch, Kafka,
OpenTelemetry, Nginx, or a frontend framework.

## How to use this handbook

Work through one checkpoint at a time. Each checkpoint has:

1. **Reason:** the engineering lesson.
2. **Implementation:** exact files and copy-pasteable code.
3. **Verification:** a command or manual observation.
4. **Expected result:** the completion condition.

Code blocks labelled **complete file** replace the named file. Smaller blocks
state exactly where they belong. A complete-file block contains no `...`
placeholder. Preserve the completed SSE increment in source control before
starting.

The implementation checkpoints are learner-led. The final automated-test
checkpoint is a separate AI handoff, matching the SSE handbook: first inspect
the protocol manually, then ask AI to prove the behavior without redesigning
it.

## Phase outcome

At the end of the implementation checkpoints, Gatherly has:

- `POST /api/chat/websocket-tickets`, protected by the existing bearer JWT;
- `GET /api/events/:eventId/chat/messages`, a protected keyset-paginated REST
  history endpoint;
- a WebSocket upgrade at `/api/chat/socket` using subprotocol
  `gatherly.chat.v1` and a one-use, short-lived ticket;
- one active event-chat subscription per socket;
- persisted, idempotent `chat.message.send` commands;
- soft-delete moderation by the author or a current active community
  moderator, organizer, or owner;
- transient typing state which expires automatically;
- Redis-backed presence leases which tolerate process crashes and expire;
- cross-instance Redis Pub/Sub containing only rebuildable identifiers for
  durable messages;
- current account, community, membership, and role authorization checks;
- schema validation, command limits, maximum payload size, ping/pong liveness,
  outbound-buffer protection, bounded connection age, and cleanup; and
- graceful shutdown which closes WebSockets before the HTTP drain.

The architecture is:

```text
browser
  -> POST /api/chat/websocket-tickets with Bearer JWT
  -> Redis SET one-use ticket with 30-second TTL
  -> WebSocket /api/chat/socket
       Sec-WebSocket-Protocol: gatherly.chat.v1, gatherly.ticket.<opaque>
  -> upgrade consumes ticket atomically
  -> PostgreSQL rechecks active account

chat.message.send
  -> validate frame
  -> reauthorize event + active membership in PostgreSQL
  -> PostgreSQL transaction
       -> lock authorization rows against concurrent revocation
       -> create/find event conversation
       -> INSERT message with clientMessageId uniqueness
  -> COMMIT
  -> acknowledge sender
  -> local fan-out
  -> best-effort Redis PUBLISH { eventId, messageId }

every application instance
  -> dedicated Redis subscriber
  -> ignore publications from itself
  -> load durable message/tombstone from PostgreSQL
  -> reauthorize each local recipient
  -> WebSocket event

reconnect
  -> obtain a new one-use ticket
  -> reopen socket with exponential backoff and jitter
  -> GET REST history using the last stored keyset cursor

Redis unavailable
  -> committed messages remain in PostgreSQL
  -> existing same-instance clients can still exchange durable messages
  -> cross-instance live fan-out, tickets, typing, and distributed presence degrade
  -> REST history recovers durable state when Redis returns
```

Four details are fundamental:

1. A message is committed before any broadcast. A frame is never durable
   merely because another browser saw it.
2. The client-generated message ID makes retries idempotent. Reusing it with a
   different body is a conflict.
3. Authentication at upgrade time does not grant permanent authorization.
   Every join, send, delete, history read, and delivery uses current database
   state.
4. Typing and presence are intentionally ephemeral. A Redis flush may erase
   them; it must not erase chat history or moderation records.

## Scope and deliberate omissions

Implement now:

- text-only event chat for current active community members;
- one event room per WebSocket connection at a time;
- REST history plus WebSocket live delivery;
- send idempotency through `clientMessageId`;
- author deletion and basic privileged moderation;
- one-use ticket authentication suitable for the browser WebSocket API;
- protocol-level ping/pong and application-level typed JSON commands;
- local rate limits and explicit backpressure behavior;
- Redis Pub/Sub fan-out and leased online presence.

Do not implement now:

- community-wide or direct-message conversations;
- attachments, rich text, links previews, reactions, threads, edits, or search;
- delivery receipts, read receipts, unread counters, or offline push;
- reports, ban workflows, word filters, shadow bans, or automated moderation;
- message encryption beyond normal TLS in a later deployment;
- a JWT in the URL, local storage, or ordinary chat logs;
- durable typing/presence tables;
- Redis Streams, Kafka, or an outbox merely to claim exactly-once delivery;
- Socket.IO or a second application server;
- Nginx configuration during local development.

Live WebSocket delivery is not a replay protocol. A connection can disappear
after commit but before broadcast. The canonical recovery path is REST history.

---

## Checkpoint 1: Record the boundary and baseline

### Reason

WebSockets bypass the normal Express request lifecycle after the HTTP upgrade.
A chat demo can appear to work while accepting cross-origin connections,
losing messages, retaining revoked permissions, leaking tickets, buffering
without bound, or hanging every shutdown. Record the baseline and the
application protocol before adding the first socket.

### Verification

Run from the repository root:

```powershell
yarn install --frozen-lockfile
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

Record:

```text
date:
git commit:
Node version:
ws version:
PostgreSQL version:
Redis version:
test files / tests passed:
baseline failures:
```

Write down this protocol contract before coding:

| Direction        | Type                     | Durable | Meaning                                          |
| ---------------- | ------------------------ | ------- | ------------------------------------------------ |
| client -> server | `chat.join`              | no      | authorize and subscribe this socket to one event |
| client -> server | `chat.leave`             | no      | leave the current event room                     |
| client -> server | `chat.message.send`      | yes     | persist an idempotent text message               |
| client -> server | `chat.message.delete`    | yes     | author deletion or privileged moderation         |
| client -> server | `chat.typing.set`        | no      | publish transient typing state                   |
| server -> client | `connection.ready`       | no      | handshake and protocol accepted                  |
| server -> client | `chat.joined`            | no      | room authorization succeeded                     |
| server -> client | `chat.left`              | no      | room was left                                    |
| server -> client | `chat.message.accepted`  | no      | command acknowledgement, includes duplicate flag |
| server -> client | `chat.message.created`   | yes     | canonical message DTO loaded after commit        |
| server -> client | `chat.message.deleted`   | yes     | canonical tombstone loaded after commit          |
| server -> client | `chat.typing.updated`    | no      | typing began or ended                            |
| server -> client | `chat.presence.snapshot` | no      | current best-effort online user IDs              |
| server -> client | `chat.presence.updated`  | no      | one user's best-effort online state changed      |
| server -> client | `error`                  | no      | safe request-correlated application error        |
| server -> client | `connection.refresh`     | no      | obtain a fresh ticket and reconnect              |

Every client command includes a UUID `requestId`. Server acknowledgements and
errors echo it. Every `chat.message.send` also contains a UUID
`clientMessageId` which remains stable across retries.

### Expected result

The existing gate passes, and every frame has an owner, durability class,
authorization rule, and client reaction.

---

## Checkpoint 2: Add event conversations, messages, and moderation audit rows

### Reason

WebSockets are a transport, not a database. A message must survive process
restart, Redis flush, disconnect, and cross-instance publication failure.
Deletion should be an explicit state transition with an audit row, not a
broadcast which leaves PostgreSQL unchanged.

This increment uses one conversation per event. That deliberately avoids a
premature polymorphic conversation model for direct messages and community
chat.

### Implementation

Do **not** create another `User` or `Event` model. Both already exist. Open
their existing declarations in `prisma/schema.prisma` and insert only these
relation fields among their other relation fields.

Inside the existing `model User { ... }`, add:

```prisma
sentChatMessages      ChatMessage[]          @relation("ChatMessageSender")
deletedChatMessages   ChatMessage[]          @relation("ChatMessageDeletedBy")
chatModerationActions ChatModerationAction[] @relation("ChatModerationActor")
```

Inside the existing `model Event { ... }`, add:

```prisma
chatConversation EventConversation?
```

Keep every existing field and relation in both models. After modifying them,
add the following genuinely new models at the end of the schema:

```prisma
model EventConversation {
  id        String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  eventId   String        @unique(map: "event_conversations_event_id_key") @map("event_id") @db.Uuid
  createdAt DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime      @default(now()) @map("updated_at") @db.Timestamptz(6)
  event     Event         @relation(fields: [eventId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  messages  ChatMessage[]

  @@map("event_conversations")
}

model ChatMessage {
  id                String                 @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  conversationId    String                 @map("conversation_id") @db.Uuid
  senderUserId      String                 @map("sender_user_id") @db.Uuid
  clientMessageId   String                 @map("client_message_id") @db.Uuid
  body              String
  deletedAt         DateTime?              @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId   String?                @map("deleted_by_user_id") @db.Uuid
  createdAt         DateTime               @default(now()) @map("created_at") @db.Timestamptz(6)
  conversation      EventConversation      @relation(fields: [conversationId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  sender            User                   @relation("ChatMessageSender", fields: [senderUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  deletedBy         User?                  @relation("ChatMessageDeletedBy", fields: [deletedByUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  moderationActions ChatModerationAction[]

  @@unique([conversationId, senderUserId, clientMessageId], map: "chat_messages_client_id_key")
  @@index([conversationId, createdAt(sort: Desc), id(sort: Desc)], map: "chat_messages_history_idx")
  @@map("chat_messages")
}

model ChatModerationAction {
  id          String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  messageId   String      @map("message_id") @db.Uuid
  actorUserId String      @map("actor_user_id") @db.Uuid
  action      String
  createdAt   DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  message     ChatMessage @relation(fields: [messageId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  actor       User        @relation("ChatModerationActor", fields: [actorUserId], references: [id], onDelete: NoAction, onUpdate: NoAction)

  @@index([messageId, createdAt], map: "chat_moderation_actions_message_idx")
  @@map("chat_moderation_actions")
}
```

Create a migration draft:

```powershell
yarn prisma migrate dev --name add_event_chat --create-only
```

Replace its `migration.sql` with this **complete file**:

```sql
CREATE TABLE "event_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "event_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_conversations_event_id_key" UNIQUE ("event_id")
);

CREATE TABLE "chat_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id" UUID NOT NULL,
  "sender_user_id" UUID NOT NULL,
  "client_message_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "deleted_at" TIMESTAMPTZ(6),
  "deleted_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000),
  CONSTRAINT "chat_messages_deletion_check" CHECK (
    ("deleted_at" IS NULL AND "deleted_by_user_id" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "deleted_by_user_id" IS NOT NULL)
  ),
  CONSTRAINT "chat_messages_client_id_key"
    UNIQUE ("conversation_id", "sender_user_id", "client_message_id")
);

CREATE TABLE "chat_moderation_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_moderation_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_moderation_actions_action_check" CHECK ("action" = 'DELETE')
);

CREATE INDEX "chat_messages_history_idx"
  ON "chat_messages" ("conversation_id", "created_at" DESC, "id" DESC);

CREATE INDEX "chat_moderation_actions_message_idx"
  ON "chat_moderation_actions" ("message_id", "created_at");

ALTER TABLE "event_conversations"
  ADD CONSTRAINT "event_conversations_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "event_conversations"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_sender_user_id_fkey"
  FOREIGN KEY ("sender_user_id") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_deleted_by_user_id_fkey"
  FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_moderation_actions"
  ADD CONSTRAINT "chat_moderation_actions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "chat_moderation_actions"
  ADD CONSTRAINT "chat_moderation_actions_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

Apply and validate:

```powershell
yarn prisma migrate dev
yarn prisma:generate
yarn prisma:validate
```

The history index is justified immediately by the implemented query in
Checkpoint 4. It supports `conversation_id = ?` followed by descending
`(created_at, id)` keyset traversal. Do not add body search indexes yet.

### Verification

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c "\d event_conversations"
docker compose exec postgres psql -U gatherly -d gatherly -c "\d chat_messages"
docker compose exec postgres psql -U gatherly -d gatherly -c "\d chat_moderation_actions"
```

### Expected result

PostgreSQL enforces one conversation per event, bounded non-empty message
bodies, one result per client message ID, consistent tombstones, and an
append-oriented audit record for deletion.

---

## Checkpoint 3: Define the application protocol and boundary schemas

### Reason

Every WebSocket frame is untrusted input. Keep domain types independent of
`ws`, Redis, Express, and PostgreSQL, then validate JSON at the transport
boundary with a discriminated union. A binary frame is outside this protocol.

### Implementation

Create `src/modules/chat/chat.types.ts` with this **complete file**:

```ts
export type CommunityChatRole = 'MEMBER' | 'MODERATOR' | 'ORGANIZER' | 'OWNER';

export interface ChatAccess {
  eventId: string;
  userId: string;
  username: string;
  role: CommunityChatRole;
}

export interface ChatMessage {
  id: string;
  eventId: string;
  sender: { id: string; username: string };
  body: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ChatHistoryCursor {
  createdAt: string;
  id: string;
}

export interface ChatHistoryPage {
  items: ChatMessage[];
  nextCursor: string | null;
}

export interface SendMessageResult {
  message: ChatMessage;
  duplicate: boolean;
}

export interface DeleteMessageResult {
  message: ChatMessage;
  changed: boolean;
}

export type ClientChatCommand =
  | { type: 'chat.join'; requestId: string; eventId: string }
  | { type: 'chat.leave'; requestId: string }
  | {
      type: 'chat.message.send';
      requestId: string;
      eventId: string;
      clientMessageId: string;
      body: string;
    }
  | {
      type: 'chat.message.delete';
      requestId: string;
      eventId: string;
      messageId: string;
    }
  | {
      type: 'chat.typing.set';
      requestId: string;
      eventId: string;
      isTyping: boolean;
    };

export type ServerChatEvent =
  | { type: 'connection.ready'; data: { protocol: 'gatherly.chat.v1' } }
  | { type: 'connection.refresh'; data: { reason: 'connection_age_limit' } }
  | { type: 'chat.joined'; requestId: string; data: { eventId: string } }
  | { type: 'chat.left'; requestId: string; data: { eventId: string | null } }
  | {
      type: 'chat.message.accepted';
      requestId: string;
      data: { messageId: string; clientMessageId: string; duplicate: boolean };
    }
  | { type: 'chat.message.deleted.accepted'; requestId: string; data: { messageId: string } }
  | { type: 'chat.message.created'; data: { message: ChatMessage } }
  | { type: 'chat.message.deleted'; data: { message: ChatMessage } }
  | {
      type: 'chat.typing.updated';
      data: { eventId: string; userId: string; username: string; isTyping: boolean };
    }
  | { type: 'chat.presence.snapshot'; data: { eventId: string; onlineUserIds: string[] } }
  | {
      type: 'chat.presence.updated';
      data: { eventId: string; userId: string; username: string; online: boolean };
    }
  | { type: 'error'; requestId?: string; error: { code: string; message: string } };

export type ChatSignal =
  | { kind: 'message.created'; eventId: string; messageId: string }
  | { kind: 'message.deleted'; eventId: string; messageId: string }
  | {
      kind: 'typing.updated';
      eventId: string;
      userId: string;
      username: string;
      isTyping: boolean;
    }
  | {
      kind: 'presence.updated';
      eventId: string;
      userId: string;
      username: string;
      online: boolean;
    };

export interface ChatSignalPublisher {
  publish(signal: ChatSignal): void;
}

export interface ChatSignalTarget {
  handleSignal(signal: ChatSignal): Promise<void>;
}

export interface ChatPresence {
  join(eventId: string, userId: string, connectionId: string): Promise<string[]>;
  renew(eventId: string, userId: string, connectionId: string): Promise<void>;
  leave(eventId: string, userId: string, connectionId: string): Promise<boolean>;
}
```

Create `src/modules/chat/chat.schemas.ts` with this **complete file**:

```ts
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
```

The request schema checks only that the cursor is a bounded base64url token.
Its decoded structure and keyset meaning belong to the repository query in the
next checkpoint. No extra module-level pagination file is introduced.

### Verification

```powershell
yarn typecheck
yarn lint
```

### Expected result

Only versioned JSON text commands enter the chat module. Unknown properties,
oversized bodies, malformed UUIDs, binary data, and invalid cursors are
rejected before business logic.

---

## Checkpoint 4: Implement transactional persistence and current authorization

### Reason

Chat authorization belongs beside the use case, not in the browser or only in
the opening handshake. Lock the account, membership, community, and event rows
while a send/delete transaction runs. A concurrent suspension or membership
update then waits or wins before the command reads authorization; the command
does not authorize from stale in-memory room membership.

History uses keyset pagination and returns tombstones without deleted bodies.
Message creation is idempotent at the database constraint. A duplicate client
ID with the same body returns the original message; the same ID with a changed
body is rejected.

### Implementation

Create `src/modules/chat/chat.repository.ts` with this **complete file**:

```ts
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
```

`FOR SHARE` conflicts with updates to the locked authorization rows. It does
not mean a member can never be revoked; it establishes a clear order between
the chat command and the revocation transaction. If revocation commits first,
the command is denied. If the command commits first, it was authorized at its
serialization point and the later revocation governs later actions.

Create `src/modules/chat/chat.service.ts` with this **complete file**:

```ts
import { AppError } from '../../shared/errors/app-error.js';
import type { ChatRepository } from './chat.repository.js';
import type {
  ChatAccess,
  ChatHistoryPage,
  ChatMessage,
  DeleteMessageResult,
  SendMessageResult,
} from './chat.types.js';

export class ChatService {
  public constructor(private readonly repository: ChatRepository) {}

  public async requireActiveUser(userId: string): Promise<{ userId: string; username: string }> {
    const username = await this.repository.findActiveUsername(userId);
    if (username === null) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }
    return { userId, username };
  }

  public async requireAccess(eventId: string, userId: string): Promise<ChatAccess> {
    const access = await this.repository.findAccess(eventId, userId);
    if (access === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return access;
  }

  public async history(
    eventId: string,
    userId: string,
    encodedCursor: string | undefined,
    limit: number,
  ): Promise<ChatHistoryPage> {
    const page = await this.repository.findHistory(eventId, userId, encodedCursor, limit);
    if (page === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return page;
  }

  public async sendMessage(
    eventId: string,
    userId: string,
    clientMessageId: string,
    body: string,
  ): Promise<SendMessageResult> {
    const result = await this.repository.createMessage(eventId, userId, clientMessageId, body);
    if (result === null) {
      throw new AppError(403, 'CHAT_ACCESS_DENIED', 'Active community membership is required');
    }
    return result;
  }

  public async deleteMessage(
    eventId: string,
    messageId: string,
    actorUserId: string,
  ): Promise<DeleteMessageResult> {
    const result = await this.repository.deleteMessage(eventId, messageId, actorUserId);
    if (result === null) {
      throw new AppError(404, 'CHAT_MESSAGE_NOT_FOUND', 'Chat message was not found');
    }
    if (result === 'FORBIDDEN') {
      throw new AppError(403, 'CHAT_MODERATION_DENIED', 'You cannot delete this message');
    }
    return result;
  }

  public findMessageForBroadcast(eventId: string, messageId: string): Promise<ChatMessage | null> {
    return this.repository.findMessageForBroadcast(eventId, messageId);
  }
}
```

### Verification

```powershell
yarn typecheck
yarn lint
```

Inspect the SQL manually: every value is parameterized, access is checked
against the target event, message IDs are constrained to that event, and the
message or tombstone is committed before the service returns.

### Expected result

Chat history, send, delete, and broadcast lookup all use PostgreSQL truth.
Cross-event ID substitution cannot expose or mutate a message, retries do not
duplicate a send, and moderation leaves an audit row.

---

## Checkpoint 5: Exchange the bearer token for a one-use WebSocket ticket

### Reason

The browser `WebSocket` constructor cannot attach an arbitrary Authorization
header. Putting the long-lived JWT in `?token=` exposes it to URL-oriented
logging and tooling. Instead, an ordinary authenticated POST creates a random,
single-use, 30-second ticket. The browser offers it as a secondary WebSocket
subprotocol; the server echoes only `gatherly.chat.v1`, never the ticket.

Tickets are transient authorization material, so Redis is an appropriate
owner. If Redis is unavailable, ticket creation returns `503`; no durable chat
data is lost. Store only a SHA-256 digest as the Redis key so Redis inspection
does not reveal the presented ticket.

### Implementation

Create `src/infrastructure/redis/websocket-ticket-store.ts` with this
**complete file**:

```ts
import { createHash, randomBytes } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type { AuthenticatedUser } from '../../modules/identity/identity.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { GatherlyRedisClient } from './client.js';

const ticketValueSchema = z.strictObject({
  userId: z.uuid(),
  username: z.string().min(1),
  issuedAt: z.iso.datetime(),
});

export interface ConsumedWebSocketTicket {
  userId: string;
  username: string;
}

const digest = (ticket: string): string => createHash('sha256').update(ticket).digest('hex');

export class WebSocketTicketStore {
  public constructor(
    private readonly redis: GatherlyRedisClient,
    private readonly logger: Logger,
    private readonly ttlSeconds: number,
  ) {}

  public async issue(user: AuthenticatedUser): Promise<{ ticket: string; expiresIn: number }> {
    if (!this.redis.isReady) {
      throw new AppError(503, 'CHAT_HANDSHAKE_UNAVAILABLE', 'Chat handshake is unavailable');
    }

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ticket = randomBytes(32).toString('base64url');
        const stored = await this.redis.set(
          `gatherly:v1:websocket-ticket:${digest(ticket)}`,
          JSON.stringify({
            userId: user.id,
            username: user.username,
            issuedAt: new Date().toISOString(),
          }),
          { EX: this.ttlSeconds, NX: true },
        );
        if (stored === 'OK') return { ticket, expiresIn: this.ttlSeconds };
      }
      throw new Error('Could not allocate a unique WebSocket ticket');
    } catch (error) {
      this.logger.warn({ err: error }, 'WebSocket ticket creation failed');
      throw new AppError(503, 'CHAT_HANDSHAKE_UNAVAILABLE', 'Chat handshake is unavailable');
    }
  }

  public async consume(ticket: string): Promise<ConsumedWebSocketTicket | null> {
    if (!this.redis.isReady) return null;

    try {
      const value = await this.redis.getDel(`gatherly:v1:websocket-ticket:${digest(ticket)}`);
      if (value === null) return null;
      const parsedJson: unknown = JSON.parse(value);
      const parsed = ticketValueSchema.safeParse(parsedJson);
      if (!parsed.success) return null;
      return { userId: parsed.data.userId, username: parsed.data.username };
    } catch (error) {
      this.logger.warn({ err: error }, 'WebSocket ticket consumption failed');
      return null;
    }
  }
}
```

Create `src/modules/chat/chat.controller.ts` with this **complete file**:

```ts
import type { RequestHandler } from 'express';

import type { WebSocketTicketStore } from '../../infrastructure/redis/websocket-ticket-store.js';
import { getAuthenticatedUser } from '../../shared/auth/authentication.middleware.js';
import { getValidated } from '../../shared/validation/validate.middleware.js';
import type { ChatService } from './chat.service.js';
import type { ChatHistoryRequest } from './chat.schemas.js';

export class ChatController {
  public constructor(
    private readonly service: ChatService,
    private readonly tickets: WebSocketTicketStore,
  ) {}

  public readonly issueTicket: RequestHandler = async (_request, response) => {
    const result = await this.tickets.issue(getAuthenticatedUser(response));
    response.status(201).json({ data: result });
  };

  public readonly history: RequestHandler = async (_request, response) => {
    const { params, query } = getValidated<ChatHistoryRequest>(response);
    const page = await this.service.history(
      params.eventId,
      getAuthenticatedUser(response).id,
      query.cursor,
      query.limit,
    );
    response.status(200).json({ data: page.items, pagination: { nextCursor: page.nextCursor } });
  };
}
```

Create `src/modules/chat/chat.routes.ts` with this **complete file**:

```ts
import { type RequestHandler, Router } from 'express';

import { validate } from '../../shared/validation/validate.middleware.js';
import type { ChatController } from './chat.controller.js';
import { chatHistoryRequestSchema } from './chat.schemas.js';

export const createChatRouter = (
  controller: ChatController,
  requireAuthenticatedUser: RequestHandler,
): Router => {
  const router = Router();
  router.post('/chat/websocket-tickets', requireAuthenticatedUser, controller.issueTicket);
  router.get(
    '/events/:eventId/chat/messages',
    requireAuthenticatedUser,
    validate(chatHistoryRequestSchema),
    controller.history,
  );
  return router;
};
```

Do not log `Sec-WebSocket-Protocol`, the returned ticket, Redis ticket values,
or request/response bodies from this endpoint.

### Verification

```powershell
yarn typecheck
yarn lint
```

With Redis running, issue two tickets and confirm they differ. Consume one in a
temporary focused test or Redis CLI session and prove its key disappears.
Waiting beyond the configured TTL must also make it unusable.

### Expected result

The durable bearer token is validated through the existing Express path. The
WebSocket receives only an opaque, one-use, short-lived credential, and ticket
reuse fails atomically.

---

## Checkpoint 6: Add Redis fan-out and leased presence

### Reason

A socket exists in one Node process. Without cross-instance fan-out, clients
connected to another instance do not see a live message. Redis Pub/Sub is a
good low-latency notification layer but has at-most-once delivery, so durable
signals contain only `eventId` and `messageId`; receivers reload PostgreSQL.

Typing and presence have no durable meaning. Presence uses one sorted-set
member per connection with an expiry timestamp as its score. Heartbeats renew
the lease. A crashed process stops renewing, and later snapshots remove expired
members. Multiple tabs remain independent leases, so closing one tab does not
make the user offline while another tab is active.

### Implementation

Create `src/infrastructure/redis/chat-bus.ts` with this **complete file**:

```ts
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import type {
  ChatSignal,
  ChatSignalPublisher,
  ChatSignalTarget,
} from '../../modules/chat/chat.types.js';
import { closeRedisClient, type GatherlyRedisClient } from './client.js';

const chatChannel = 'gatherly:chat:signals:v1';

const chatSignalSchema: z.ZodType<ChatSignal> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message.created'), eventId: z.uuid(), messageId: z.uuid() }),
  z.strictObject({ kind: z.literal('message.deleted'), eventId: z.uuid(), messageId: z.uuid() }),
  z.strictObject({
    kind: z.literal('typing.updated'),
    eventId: z.uuid(),
    userId: z.uuid(),
    username: z.string().min(1),
    isTyping: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('presence.updated'),
    eventId: z.uuid(),
    userId: z.uuid(),
    username: z.string().min(1),
    online: z.boolean(),
  }),
]);

const envelopeSchema = z.strictObject({
  origin: z.uuid(),
  signal: chatSignalSchema,
});

export class RedisChatBus implements ChatSignalPublisher {
  private readonly instanceId = randomUUID();
  private target: ChatSignalTarget | undefined;
  private started = false;

  public constructor(
    private readonly publisher: GatherlyRedisClient,
    private readonly subscriber: GatherlyRedisClient,
    private readonly logger: Logger,
  ) {}

  public start(target: ChatSignalTarget): void {
    if (this.started) return;
    this.started = true;
    this.target = target;

    void this.subscriber
      .connect()
      .then(() =>
        this.subscriber.subscribe(chatChannel, (value) => {
          try {
            const parsedJson: unknown = JSON.parse(value);
            const envelope = envelopeSchema.parse(parsedJson);
            if (envelope.origin === this.instanceId) return;
            void this.deliverLocally(envelope.signal);
          } catch (error) {
            this.logger.warn({ err: error }, 'Discarding invalid chat Pub/Sub signal');
          }
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Chat Redis subscription unavailable');
      });
  }

  public publish(signal: ChatSignal): void {
    void this.deliverLocally(signal);
    if (!this.publisher.isReady) return;

    const envelope = JSON.stringify({ origin: this.instanceId, signal });
    void this.publisher.publish(chatChannel, envelope).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Chat Redis publication failed');
    });
  }

  public async close(): Promise<void> {
    this.target = undefined;
    if (this.subscriber.isReady) await this.subscriber.unsubscribe(chatChannel);
    await closeRedisClient(this.subscriber);
  }

  private async deliverLocally(signal: ChatSignal): Promise<void> {
    try {
      await this.target?.handleSignal(signal);
    } catch (error) {
      this.logger.warn({ err: error, kind: signal.kind }, 'Local chat signal failed');
    }
  }
}

export const createChatSubscriber = (
  publisher: GatherlyRedisClient,
  logger: Logger,
): GatherlyRedisClient => {
  const subscriber = publisher.duplicate();
  subscriber.on('error', (error) => {
    logger.warn({ err: error }, 'Chat Redis subscriber error');
  });
  return subscriber;
};
```

Create `src/infrastructure/redis/chat-presence.ts` with this **complete file**:

```ts
import type { Logger } from 'pino';

import type { ChatPresence } from '../../modules/chat/chat.types.js';
import type { GatherlyRedisClient } from './client.js';

const member = (userId: string, connectionId: string): string => `${userId}.${connectionId}`;
const userIdFromMember = (value: string): string => value.slice(0, 36);

export class RedisChatPresence implements ChatPresence {
  private readonly local = new Map<string, Map<string, string>>();

  public constructor(
    private readonly redis: GatherlyRedisClient,
    private readonly logger: Logger,
    private readonly leaseMs: number,
  ) {}

  public async join(eventId: string, userId: string, connectionId: string): Promise<string[]> {
    let localEvent = this.local.get(eventId);
    if (localEvent === undefined) {
      localEvent = new Map();
      this.local.set(eventId, localEvent);
    }
    localEvent.set(connectionId, userId);
    await this.writeLease(eventId, userId, connectionId);
    return this.snapshot(eventId);
  }

  public renew(eventId: string, userId: string, connectionId: string): Promise<void> {
    return this.writeLease(eventId, userId, connectionId);
  }

  public async leave(eventId: string, userId: string, connectionId: string): Promise<boolean> {
    const localEvent = this.local.get(eventId);
    localEvent?.delete(connectionId);
    if (localEvent?.size === 0) this.local.delete(eventId);

    if (this.redis.isReady) {
      try {
        await this.redis.zRem(this.key(eventId), member(userId, connectionId));
      } catch (error) {
        this.logger.warn({ err: error }, 'Chat presence removal failed');
      }
    }
    return (await this.snapshot(eventId)).includes(userId);
  }

  private async writeLease(eventId: string, userId: string, connectionId: string): Promise<void> {
    if (!this.redis.isReady) return;

    try {
      const key = this.key(eventId);
      await this.redis.zAdd(key, [
        { score: Date.now() + this.leaseMs, value: member(userId, connectionId) },
      ]);
      await this.redis.expire(key, Math.ceil(this.leaseMs / 1_000) * 2);
    } catch (error) {
      this.logger.warn({ err: error }, 'Chat presence lease update failed');
    }
  }

  private async snapshot(eventId: string): Promise<string[]> {
    const userIds = new Set(this.local.get(eventId)?.values() ?? []);
    if (!this.redis.isReady) return [...userIds].sort();

    try {
      const key = this.key(eventId);
      const now = Date.now();
      await this.redis.zRemRangeByScore(key, 0, now);
      const active = await this.redis.zRangeByScore(key, now + 1, '+inf');
      for (const value of active) userIds.add(userIdFromMember(value));
    } catch (error) {
      this.logger.warn({ err: error }, 'Chat presence snapshot failed');
    }
    return [...userIds].sort();
  }

  private key(eventId: string): string {
    return `gatherly:v1:chat:presence:${eventId}`;
  }
}
```

Millisecond epoch values are far below Redis sorted sets' exact-integer limit
of `2^53`, so lease comparisons are precise. The key itself also expires after
roughly two lease windows, preventing empty room keys from accumulating.

### Verification

```powershell
yarn typecheck
yarn lint
```

Use Redis CLI to inspect one presence key while a client is connected. Its
score should move forward on heartbeat. Stop the client without graceful
cleanup and confirm a later snapshot removes the expired member.

### Expected result

Durable fan-out always reloads PostgreSQL. Typing and presence are explicitly
best effort, local delivery still works when Redis disappears, and crashed
connections age out without a durable cleanup job.

---

## Checkpoint 7: Own WebSocket sessions, commands, heartbeat, and backpressure

### Reason

A WebSocket is not a sequence of independent Express requests. One gateway
must own per-connection state, serialize commands, enforce one room, track
liveness, expire typing, periodically reauthorize, guard outbound buffering,
and clean up every exit path.

The gateway closes a connection when `bufferedAmount` is above the configured
limit. It does not create an unbounded application queue. The client recovers
durable messages through REST history.

### Implementation

Create `src/infrastructure/http/chat-websocket-gateway.ts` with this **complete
file**:

```ts
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';
import WebSocket, { type RawData } from 'ws';

import type { ChatService } from '../../modules/chat/chat.service.js';
import { clientChatCommandSchema } from '../../modules/chat/chat.schemas.js';
import type {
  ChatPresence,
  ChatSignal,
  ChatSignalPublisher,
  ChatSignalTarget,
  ClientChatCommand,
  ServerChatEvent,
} from '../../modules/chat/chat.types.js';
import { AppError } from '../../shared/errors/app-error.js';

interface GatewayConfiguration {
  heartbeatIntervalMs: number;
  maxConnectionDurationMs: number;
  maxBufferedBytes: number;
  commandLimit: number;
  commandWindowMs: number;
  typingTtlMs: number;
}

interface ChatSession {
  id: string;
  socket: WebSocket;
  userId: string;
  username: string;
  eventId: string | null;
  openedAt: number;
  alive: boolean;
  closed: boolean;
  heartbeatRunning: boolean;
  commandTimes: number[];
  queue: Promise<void>;
  typingTimer: NodeJS.Timeout | undefined;
}

const asText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
};

export class ChatWebSocketGateway implements ChatSignalTarget {
  private readonly sessions = new Map<string, ChatSession>();
  private acceptingConnections = true;
  private readonly heartbeatTimer: NodeJS.Timeout;

  public constructor(
    private readonly service: ChatService,
    private readonly signals: ChatSignalPublisher,
    private readonly presence: ChatPresence,
    private readonly logger: Logger,
    private readonly configuration: GatewayConfiguration,
  ) {
    this.heartbeatTimer = setInterval(() => {
      for (const session of this.sessions.values()) void this.heartbeat(session);
    }, configuration.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  public accept(socket: WebSocket, user: { userId: string; username: string }): void {
    if (!this.acceptingConnections) {
      socket.close(1013, 'server_draining');
      return;
    }

    const session: ChatSession = {
      id: randomUUID(),
      socket,
      userId: user.userId,
      username: user.username,
      eventId: null,
      openedAt: Date.now(),
      alive: true,
      closed: false,
      heartbeatRunning: false,
      commandTimes: [],
      queue: Promise.resolve(),
      typingTimer: undefined,
    };
    this.sessions.set(session.id, session);

    socket.on('pong', () => {
      session.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text_frames_only');
        return;
      }
      session.queue = session.queue
        .then(() => this.onMessage(session, asText(data)))
        .catch((error: unknown) => {
          this.logger.error({ err: error, userId: session.userId }, 'Chat command queue failed');
          this.closeSession(session, 1011, 'internal_error');
        });
    });
    socket.once('close', () => {
      void this.cleanup(session);
    });
    socket.on('error', (error) => {
      this.logger.warn({ err: error, userId: session.userId }, 'Chat WebSocket error');
    });

    this.send(session, { type: 'connection.ready', data: { protocol: 'gatherly.chat.v1' } });
  }

  public async handleSignal(signal: ChatSignal): Promise<void> {
    if (signal.kind === 'message.created' || signal.kind === 'message.deleted') {
      const message = await this.service.findMessageForBroadcast(signal.eventId, signal.messageId);
      if (message === null) return;
      const type = message.deletedAt === null ? 'chat.message.created' : 'chat.message.deleted';
      await this.broadcastAuthorized(signal.eventId, { type, data: { message } });
      return;
    }

    if (signal.kind === 'typing.updated') {
      await this.broadcastAuthorized(signal.eventId, {
        type: 'chat.typing.updated',
        data: {
          eventId: signal.eventId,
          userId: signal.userId,
          username: signal.username,
          isTyping: signal.isTyping,
        },
      });
      return;
    }

    await this.broadcastAuthorized(signal.eventId, {
      type: 'chat.presence.updated',
      data: {
        eventId: signal.eventId,
        userId: signal.userId,
        username: signal.username,
        online: signal.online,
      },
    });
  }

  public async shutdown(): Promise<void> {
    if (!this.acceptingConnections) return;
    this.acceptingConnections = false;
    clearInterval(this.heartbeatTimer);

    await Promise.all([...this.sessions.values()].map((session) => this.leaveRoom(session)));
    for (const session of this.sessions.values())
      this.closeSession(session, 1001, 'server_shutdown');
  }

  private async onMessage(session: ChatSession, text: string): Promise<void> {
    if (session.closed) return;
    if (!this.consumeCommandQuota(session)) {
      this.sendError(session, undefined, 'CHAT_RATE_LIMITED', 'Too many chat commands');
      this.closeSession(session, 1008, 'rate_limited');
      return;
    }

    let command: ClientChatCommand;
    try {
      const parsedJson: unknown = JSON.parse(text);
      command = clientChatCommandSchema.parse(parsedJson);
    } catch {
      this.sendError(session, undefined, 'INVALID_CHAT_FRAME', 'Chat frame is invalid');
      return;
    }

    try {
      await this.execute(session, command);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(session, command.requestId, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  private async execute(session: ChatSession, command: ClientChatCommand): Promise<void> {
    if (command.type === 'chat.join') {
      const access = await this.service.requireAccess(command.eventId, session.userId);
      if (session.eventId !== null && session.eventId !== command.eventId) {
        await this.leaveRoom(session);
      }
      session.eventId = command.eventId;
      const onlineUserIds = await this.presence.join(command.eventId, session.userId, session.id);
      this.send(session, {
        type: 'chat.joined',
        requestId: command.requestId,
        data: { eventId: command.eventId },
      });
      this.send(session, {
        type: 'chat.presence.snapshot',
        data: { eventId: command.eventId, onlineUserIds },
      });
      this.signals.publish({
        kind: 'presence.updated',
        eventId: command.eventId,
        userId: access.userId,
        username: access.username,
        online: true,
      });
      return;
    }

    if (command.type === 'chat.leave') {
      const eventId = session.eventId;
      await this.leaveRoom(session);
      this.send(session, { type: 'chat.left', requestId: command.requestId, data: { eventId } });
      return;
    }

    this.assertJoined(session, command.eventId);

    if (command.type === 'chat.message.send') {
      const result = await this.service.sendMessage(
        command.eventId,
        session.userId,
        command.clientMessageId,
        command.body,
      );
      this.send(session, {
        type: 'chat.message.accepted',
        requestId: command.requestId,
        data: {
          messageId: result.message.id,
          clientMessageId: command.clientMessageId,
          duplicate: result.duplicate,
        },
      });
      if (!result.duplicate) {
        this.signals.publish({
          kind: 'message.created',
          eventId: command.eventId,
          messageId: result.message.id,
        });
      }
      return;
    }

    if (command.type === 'chat.message.delete') {
      const result = await this.service.deleteMessage(
        command.eventId,
        command.messageId,
        session.userId,
      );
      this.send(session, {
        type: 'chat.message.deleted.accepted',
        requestId: command.requestId,
        data: { messageId: result.message.id },
      });
      if (result.changed) {
        this.signals.publish({
          kind: 'message.deleted',
          eventId: command.eventId,
          messageId: result.message.id,
        });
      }
      return;
    }

    await this.service.requireAccess(command.eventId, session.userId);
    this.setTyping(session, command.isTyping);
  }

  private setTyping(session: ChatSession, isTyping: boolean): void {
    if (session.eventId === null) return;
    if (session.typingTimer !== undefined) clearTimeout(session.typingTimer);
    session.typingTimer = undefined;
    this.publishTyping(session, isTyping);

    if (isTyping) {
      session.typingTimer = setTimeout(() => {
        session.typingTimer = undefined;
        this.publishTyping(session, false);
      }, this.configuration.typingTtlMs);
      session.typingTimer.unref();
    }
  }

  private publishTyping(session: ChatSession, isTyping: boolean): void {
    if (session.eventId === null) return;
    this.signals.publish({
      kind: 'typing.updated',
      eventId: session.eventId,
      userId: session.userId,
      username: session.username,
      isTyping,
    });
  }

  private async leaveRoom(session: ChatSession): Promise<void> {
    const eventId = session.eventId;
    if (eventId === null) return;
    if (session.typingTimer !== undefined) clearTimeout(session.typingTimer);
    session.typingTimer = undefined;
    this.publishTyping(session, false);
    session.eventId = null;

    const stillOnline = await this.presence.leave(eventId, session.userId, session.id);
    this.signals.publish({
      kind: 'presence.updated',
      eventId,
      userId: session.userId,
      username: session.username,
      online: stillOnline,
    });
  }

  private async heartbeat(session: ChatSession): Promise<void> {
    if (session.closed || session.heartbeatRunning) return;
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.heartbeatRunning = true;
    try {
      if (!session.alive) {
        session.socket.terminate();
        return;
      }
      if (Date.now() - session.openedAt >= this.configuration.maxConnectionDurationMs) {
        this.send(session, {
          type: 'connection.refresh',
          data: { reason: 'connection_age_limit' },
        });
        this.closeSession(session, 4001, 'refresh_required');
        return;
      }

      session.alive = false;
      session.socket.ping();
      if (session.eventId !== null) {
        try {
          await this.service.requireAccess(session.eventId, session.userId);
          await this.presence.renew(session.eventId, session.userId, session.id);
        } catch {
          await this.leaveRoom(session);
          this.closeSession(session, 4003, 'authorization_revoked');
        }
      }
    } finally {
      session.heartbeatRunning = false;
    }
  }

  private async broadcastAuthorized(eventId: string, event: ServerChatEvent): Promise<void> {
    const recipients = [...this.sessions.values()].filter(
      (session) => !session.closed && session.eventId === eventId,
    );
    await Promise.all(
      recipients.map(async (session) => {
        try {
          await this.service.requireAccess(eventId, session.userId);
          this.send(session, event);
        } catch {
          await this.leaveRoom(session);
          this.closeSession(session, 4003, 'authorization_revoked');
        }
      }),
    );
  }

  private consumeCommandQuota(session: ChatSession): boolean {
    const cutoff = Date.now() - this.configuration.commandWindowMs;
    session.commandTimes = session.commandTimes.filter((timestamp) => timestamp > cutoff);
    if (session.commandTimes.length >= this.configuration.commandLimit) return false;
    session.commandTimes.push(Date.now());
    return true;
  }

  private assertJoined(session: ChatSession, eventId: string): void {
    if (session.eventId !== eventId) {
      throw new AppError(409, 'CHAT_NOT_JOINED', 'Join this event chat first');
    }
  }

  private send(session: ChatSession, event: ServerChatEvent): boolean {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return false;
    if (session.socket.bufferedAmount > this.configuration.maxBufferedBytes) {
      this.closeSession(session, 1013, 'backpressure');
      return false;
    }
    session.socket.send(JSON.stringify(event), (error) => {
      if (error !== undefined) {
        this.logger.warn({ err: error, userId: session.userId }, 'Chat frame send failed');
        this.closeSession(session, 1011, 'send_failed');
      }
    });
    return true;
  }

  private sendError(
    session: ChatSession,
    requestId: string | undefined,
    code: string,
    message: string,
  ): void {
    this.send(session, {
      type: 'error',
      ...(requestId === undefined ? {} : { requestId }),
      error: { code, message },
    });
  }

  private closeSession(session: ChatSession, code: number, reason: string): void {
    if (session.closed || session.socket.readyState >= WebSocket.CLOSING) return;
    session.socket.close(code, reason);
  }

  private async cleanup(session: ChatSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    await this.leaveRoom(session);
  }
}
```

The socket command queue preserves the order in which one client issued join,
send, typing, and leave. It does not serialize different clients. PostgreSQL
constraints and row locks handle their concurrency.

`ping()` is protocol-level liveness; clients do not send a JSON `ping` command.
The `ws` library automatically answers ping frames with pong frames. The next
heartbeat terminates a connection which did not answer the prior ping.

### Verification

```powershell
yarn typecheck
yarn lint
```

Review every timer and listener path. Typing timers clear on false/leave/close,
the shared heartbeat timer clears on shutdown, and a session is deleted once.

### Expected result

Each connection has one room, one serialized command chain, bounded command
history, bounded outbound buffering, expiring typing, current authorization,
ping/pong liveness, bounded age, and idempotent cleanup.

---

## Checkpoint 8: Authenticate the HTTP upgrade and negotiate one protocol

### Reason

Express does not process a connection after HTTP switches protocols. The Node
HTTP server emits `upgrade`; the application must validate the path, Origin,
subprotocol, ticket, current account, and draining state before calling
`handleUpgrade`.

Use `WebSocketServer({ noServer: true })` so Gatherly keeps one HTTP server and
one port. Disable per-message compression for these small frames: compression
adds memory and CPU complexity and is not justified by measured traffic. Set
`maxPayload` explicitly because the `ws` default is much larger than the chat
protocol needs.

### Implementation

Create `src/infrastructure/http/chat-websocket-server.ts` with this **complete
file**:

```ts
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';

import type { ChatService } from '../../modules/chat/chat.service.js';
import type { WebSocketTicketStore } from '../redis/websocket-ticket-store.js';
import type { ChatWebSocketGateway } from './chat-websocket-gateway.js';

const protocol = 'gatherly.chat.v1';
const ticketPrefix = 'gatherly.ticket.';
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;

interface ChatWebSocketServerConfiguration {
  allowedOrigin: string;
  maxPayloadBytes: number;
}

const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
  if (socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
};

const readTicket = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const offered = header.split(',').map((value) => value.trim());
  if (offered.length !== 2 || !offered.includes(protocol)) return null;
  const ticketProtocol = offered.find((value) => value.startsWith(ticketPrefix));
  if (ticketProtocol === undefined) return null;
  const ticket = ticketProtocol.slice(ticketPrefix.length);
  return ticketPattern.test(ticket) ? ticket : null;
};

export class ChatWebSocketServer {
  private readonly webSocketServer: WebSocketServer;
  private started = false;

  public constructor(
    private readonly server: Server,
    private readonly tickets: WebSocketTicketStore,
    private readonly chatService: ChatService,
    private readonly gateway: ChatWebSocketGateway,
    private readonly logger: Logger,
    private readonly configuration: ChatWebSocketServerConfiguration,
  ) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      perMessageDeflate: false,
      maxPayload: configuration.maxPayloadBytes,
      handleProtocols: (protocols) => (protocols.has(protocol) ? protocol : false),
    });
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.server.on('upgrade', this.handleUpgrade);
  }

  public async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.server.off('upgrade', this.handleUpgrade);
    await this.gateway.shutdown();

    const forceTimer = setTimeout(() => {
      for (const client of this.webSocketServer.clients) client.terminate();
    }, 1_000);
    forceTimer.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        this.webSocketServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    } finally {
      clearTimeout(forceTimer);
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? '/', 'http://gatherly.local').pathname;
    if (pathname !== '/api/chat/socket') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!this.started) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (request.headers.origin !== this.configuration.allowedOrigin) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const ticket = readTicket(request.headers['sec-websocket-protocol']);
    if (ticket === null) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const onSocketError = (error: Error): void => {
      this.logger.warn({ err: error }, 'WebSocket upgrade socket failed');
    };
    socket.once('error', onSocketError);

    void this.tickets
      .consume(ticket)
      .then(async (consumed) => {
        if (consumed === null) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        const currentUser = await this.chatService.requireActiveUser(consumed.userId);
        if (socket.destroyed) return;
        if (!this.started) {
          rejectUpgrade(socket, 503, 'Service Unavailable');
          return;
        }

        socket.removeListener('error', onSocketError);
        this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          this.gateway.accept(webSocket, currentUser);
        });
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error }, 'WebSocket upgrade authentication failed');
        rejectUpgrade(socket, 401, 'Unauthorized');
      });
  };
}
```

The ticket value contains a username only for inspection/debugging without a
database join, but the upgrade deliberately discards it and reloads the
current active user. This keeps the account check authoritative.

The Origin check is not CORS: CORS middleware does not protect WebSocket
upgrades. Browser clients send their page origin during the handshake, and the
server compares it to the configured frontend origin. The manual Node client
in Checkpoint 11 must set the same Origin explicitly.

### Verification

```powershell
yarn typecheck
yarn lint
```

Try the wrong path, missing Origin, wrong Origin, missing protocol, malformed
ticket, expired ticket, and reused ticket. None may reach
`connection.ready`. A valid ticket must negotiate exactly
`gatherly.chat.v1`—the selected protocol must never echo the ticket.

### Expected result

Only the configured path and origin can upgrade. Authentication completes
before `101 Switching Protocols`, every ticket is consumed once, and the
current account is active.

---

## Checkpoint 9: Validate configuration and wire the modular monolith

### Reason

Ticket lifetime, payload bounds, heartbeat, presence lease, buffer limits,
command limits, typing expiry, and connection age are operational choices.
Parse them once. The composition root should visibly own every Redis client,
HTTP upgrade listener, long-lived connection, and shutdown action.

Redis remains absent from readiness because canonical HTTP history and
PostgreSQL truth remain available. The ticket endpoint can return a localized
`503` while Redis is unavailable.

### Implementation

Add these fields to `environmentSchema` in `src/config/env.ts`:

```ts
  WS_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(65_536).default(16_384),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(60_000).default(30_000),
  WS_PRESENCE_LEASE_MS: z.coerce.number().int().min(15_000).max(300_000).default(90_000),
  WS_MAX_CONNECTION_DURATION_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(600_000),
  WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(16_384).max(4_194_304).default(262_144),
  WS_COMMAND_LIMIT: z.coerce.number().int().min(1).max(1_000).default(30),
  WS_COMMAND_WINDOW_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  WS_TYPING_TTL_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
```

Keep the presence lease at least three heartbeat intervals when changing
defaults. Add to `.env.example`:

```dotenv
# WebSockets and event chat
WS_TICKET_TTL_SECONDS=30
WS_MAX_PAYLOAD_BYTES=16384
WS_HEARTBEAT_INTERVAL_MS=30000
WS_PRESENCE_LEASE_MS=90000
WS_MAX_CONNECTION_DURATION_MS=600000
WS_MAX_BUFFERED_BYTES=262144
WS_COMMAND_LIMIT=30
WS_COMMAND_WINDOW_MS=10000
WS_TYPING_TTL_MS=5000
```

Add the same variables to `app.environment` in `compose.yaml`:

```yaml
WS_TICKET_TTL_SECONDS: ${WS_TICKET_TTL_SECONDS:-30}
WS_MAX_PAYLOAD_BYTES: ${WS_MAX_PAYLOAD_BYTES:-16384}
WS_HEARTBEAT_INTERVAL_MS: ${WS_HEARTBEAT_INTERVAL_MS:-30000}
WS_PRESENCE_LEASE_MS: ${WS_PRESENCE_LEASE_MS:-90000}
WS_MAX_CONNECTION_DURATION_MS: ${WS_MAX_CONNECTION_DURATION_MS:-600000}
WS_MAX_BUFFERED_BYTES: ${WS_MAX_BUFFERED_BYTES:-262144}
WS_COMMAND_LIMIT: ${WS_COMMAND_LIMIT:-30}
WS_COMMAND_WINDOW_MS: ${WS_COMMAND_WINDOW_MS:-10000}
WS_TYPING_TTL_MS: ${WS_TYPING_TTL_MS:-5000}
```

Add an optional chat router to `AppDependencies` in `src/app.ts`:

```ts
export interface AppDependencies {
  corsOrigin: string;
  enableHttpLogging: boolean;
  logger: Logger;
  checkReadiness: () => Promise<boolean>;
  isShuttingDown: () => boolean;
  communitiesRouter: Router;
  membershipsRouter: Router;
  eventsRouter: Router;
  reservationsRouter: Router;
  identityRouter: Router;
  realtimeRouter?: Router;
  chatRouter?: Router;
}
```

Mount it with the other `/api` routers before `notFoundHandler`:

```ts
if (dependencies.chatRouter !== undefined) {
  app.use('/api', dependencies.chatRouter);
}
```

Add these imports to `src/server.ts`:

```ts
import { ChatWebSocketGateway } from './infrastructure/http/chat-websocket-gateway.js';
import { ChatWebSocketServer } from './infrastructure/http/chat-websocket-server.js';
import { RedisChatBus, createChatSubscriber } from './infrastructure/redis/chat-bus.js';
import { RedisChatPresence } from './infrastructure/redis/chat-presence.js';
import { WebSocketTicketStore } from './infrastructure/redis/websocket-ticket-store.js';
import { ChatController } from './modules/chat/chat.controller.js';
import { ChatRepository } from './modules/chat/chat.repository.js';
import { createChatRouter } from './modules/chat/chat.routes.js';
import { ChatService } from './modules/chat/chat.service.js';
```

After creating `requireAuthenticatedUser`, create the chat HTTP dependencies:

```ts
const chatRepository = new ChatRepository(pool);
const chatService = new ChatService(chatRepository);
const webSocketTickets = new WebSocketTicketStore(redis, logger, environment.WS_TICKET_TTL_SECONDS);
const chatRouter = createChatRouter(
  new ChatController(chatService, webSocketTickets),
  requireAuthenticatedUser,
);
```

Create the cross-instance and gateway objects before `createApp`:

```ts
const chatSubscriber = createChatSubscriber(redis, logger);
const chatBus = new RedisChatBus(redis, chatSubscriber, logger);
const chatPresence = new RedisChatPresence(redis, logger, environment.WS_PRESENCE_LEASE_MS);
const chatGateway = new ChatWebSocketGateway(chatService, chatBus, chatPresence, logger, {
  heartbeatIntervalMs: environment.WS_HEARTBEAT_INTERVAL_MS,
  maxConnectionDurationMs: environment.WS_MAX_CONNECTION_DURATION_MS,
  maxBufferedBytes: environment.WS_MAX_BUFFERED_BYTES,
  commandLimit: environment.WS_COMMAND_LIMIT,
  commandWindowMs: environment.WS_COMMAND_WINDOW_MS,
  typingTtlMs: environment.WS_TYPING_TTL_MS,
});
chatBus.start(chatGateway);
```

Pass `chatRouter` to `createApp`. After the existing line
`const server = createServer(app);`, create and start the upgrade owner:

```ts
const chatWebSocketServer = new ChatWebSocketServer(
  server,
  webSocketTickets,
  chatService,
  chatGateway,
  logger,
  {
    allowedOrigin: environment.CORS_ORIGIN,
    maxPayloadBytes: environment.WS_MAX_PAYLOAD_BYTES,
  },
);
chatWebSocketServer.start();
```

Replace the current graceful-shutdown callbacks with:

```ts
  closeLongLivedConnections: async () => {
    realtimeService.shutdown();
    await chatWebSocketServer.shutdown();
  },
  closeDependencies: async () => {
    await Promise.all([
      chatBus.close(),
      realtimeBus.close(),
      closeRedisClient(redis),
      prisma.$disconnect(),
      pool.end(),
    ]);
  },
```

`server.closeAllConnections()` does not destroy sockets upgraded to another
protocol. That is why the WebSocket server has its own graceful close and
one-second terminate fallback before ordinary HTTP drain waits.

Do not add Redis to `checkReadiness`. Do not construct a subscriber, gateway,
or heartbeat timer inside a route.

### Verification

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

### Expected result

The composition root owns one chat repository/service, ticket store, presence
adapter, publisher, dedicated subscriber, gateway, upgrade listener, and clear
shutdown order. Invalid WebSocket configuration stops startup.

---

## Checkpoint 10: Document the HTTP and WebSocket contracts

### Reason

OpenAPI describes the ticket and history HTTP endpoints but cannot fully model
an RFC 6455 message protocol. Keep the canonical OpenAPI current and add one
small protocol document for frames, close codes, durability, and recovery.

### Implementation

Update the description in `docs/openapi.yaml` to say the implemented API is
through the Phase 6 WebSocket increment. Add a `Chat` tag:

```yaml
- name: Chat
  description: Authenticated event-chat history and WebSocket ticket creation.
```

Add these paths before `components:` and mirror them in
`docs/openapi/chat/paths.yaml`:

```yaml
/api/chat/websocket-tickets:
  post:
    tags: [Chat]
    summary: Create a one-use WebSocket handshake ticket
    description: |
      Exchanges the current bearer authentication for a random one-use ticket
      with a short Redis TTL. Present it only in the WebSocket subprotocol
      `gatherly.ticket.<ticket>` together with `gatherly.chat.v1`.
    security: [{ bearerAuth: [] }]
    responses:
      '201':
        description: Ticket created.
        content:
          application/json:
            schema:
              type: object
              required: [data]
              properties:
                data:
                  type: object
                  required: [ticket, expiresIn]
                  properties:
                    ticket: { type: string, writeOnly: true }
                    expiresIn: { type: integer, minimum: 1 }
      '401': { $ref: '#/components/responses/AuthenticationRequired' }
      '503': { $ref: '#/components/responses/Error' }

/api/events/{eventId}/chat/messages:
  get:
    tags: [Chat]
    summary: Read event-chat history
    description: |
      Requires a current active membership in the event's active community.
      Returns newest-first messages. Deleted messages are tombstones with a
      null body. Follow `pagination.nextCursor` for older messages.
    security: [{ bearerAuth: [] }]
    parameters:
      - $ref: '#/components/parameters/EventId'
      - name: cursor
        in: query
        schema: { type: string }
      - name: limit
        in: query
        schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
    responses:
      '200':
        description: Visible history page.
        content:
          application/json:
            schema: { type: object }
      '400': { $ref: '#/components/responses/Error' }
      '401': { $ref: '#/components/responses/AuthenticationRequired' }
      '403': { $ref: '#/components/responses/Error' }
```

Add `chat/` to `docs/openapi/README.md` and create
`docs/websocket-protocol.md` with this **complete file**:

````markdown
# Gatherly WebSocket protocol v1

## Handshake

1. Send `POST /api/chat/websocket-tickets` with the bearer JWT.
2. Open `/api/chat/socket` using subprotocols `gatherly.chat.v1` and
   `gatherly.ticket.<ticket>` before the ticket expires.
3. The server selects only `gatherly.chat.v1`.

Production uses `wss://`. The ticket is one-use and must never be logged.

## Commands

Every command is one JSON text message. `requestId` is a new UUID per command.
`clientMessageId` identifies one intended message and remains stable on retry.

```json
{"type":"chat.join","requestId":"1d3dc0ef-9817-4776-a5ad-e73f351a8c81","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2"}
{"type":"chat.message.send","requestId":"c7a9fc98-da56-46aa-a200-4b5269182290","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","clientMessageId":"a85eceba-2178-42be-a94a-1d652c3a4397","body":"See you there"}
{"type":"chat.typing.set","requestId":"048be633-9658-4b23-9800-e234b88c45bb","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","isTyping":true}
{"type":"chat.message.delete","requestId":"0f3874f3-fef8-423c-8d84-11cc25a9fd93","eventId":"85e399c2-1847-4224-86be-2f8ecf0a63d2","messageId":"362a0a87-c47f-4289-8e49-c16993b952d5"}
{"type":"chat.leave","requestId":"244a37a4-1508-43cb-8e91-d27ace03358b"}
```

## Delivery and recovery

`chat.message.created` and `chat.message.deleted` describe PostgreSQL state.
Typing, presence, acknowledgements, and errors are transient. WebSocket
delivery has no replay guarantee. On reconnect, reload REST history and merge
messages by server `message.id`. Retry an unacknowledged send with the same
`clientMessageId` and original body.

## Close codes

| Code | Meaning                                   |
| ---- | ----------------------------------------- |
| 1000 | normal client close                       |
| 1001 | server shutdown                           |
| 1003 | binary frames are unsupported             |
| 1008 | command-rate policy violation             |
| 1009 | frame exceeds `WS_MAX_PAYLOAD_BYTES`      |
| 1011 | unexpected server/send error              |
| 1013 | server draining or outbound backpressure  |
| 4001 | connection age requires a fresh ticket    |
| 4003 | account or room authorization was revoked |

Reconnect abnormal/retryable closures with exponential backoff and jitter.
Do not reconnect after a deliberate sign-out until new credentials exist.
````

### Verification

Validate the canonical OpenAPI file in the same tool already used for Gatherly
and read the protocol document against the TypeScript discriminated union.
Every documented command and close code must have exactly one implementation.

### Expected result

HTTP tooling can discover ticket/history endpoints, while the separate
protocol document defines the long-lived message contract and recovery model.

---

## Checkpoint 11: Manually exercise the complete protocol

### Reason

Inspect real upgrade headers, negotiated protocol, request acknowledgements,
fan-out, reconnect, and REST recovery before tests hide those details behind
helpers. A smoke client also proves browser-incompatible assumptions have not
entered the server design.

### Implementation

Create `scripts/chat-smoke-client.ts` with this **complete file**:

```ts
import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';
import { z } from 'zod';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};

const apiUrl = process.env['API_URL'] ?? 'http://127.0.0.1:3000';
const origin = process.env['CHAT_ORIGIN'] ?? 'http://localhost:5173';
const accessToken = required('ACCESS_TOKEN');
const eventId = z.uuid().parse(required('EVENT_ID'));

const ticketResponse = await fetch(`${apiUrl}/api/chat/websocket-tickets`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!ticketResponse.ok) {
  throw new Error(`Ticket request failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
}
const ticketPayload: unknown = await ticketResponse.json();
const { ticket } = z
  .object({ data: z.object({ ticket: z.string(), expiresIn: z.number().int().positive() }) })
  .parse(ticketPayload).data;

const socketUrl = new URL('/api/chat/socket', apiUrl);
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(socketUrl, ['gatherly.chat.v1', `gatherly.ticket.${ticket}`], {
  origin,
});

const timeout = setTimeout(() => {
  socket.terminate();
  process.exitCode = 1;
}, 15_000);

let clientMessageId = '';

socket.on('open', () => {
  if (socket.protocol !== 'gatherly.chat.v1') {
    throw new Error(`Unexpected negotiated protocol: ${socket.protocol}`);
  }
});

socket.on('message', (raw, isBinary) => {
  if (isBinary) throw new Error('Server sent an unexpected binary frame');
  const frame: unknown = JSON.parse(raw.toString());
  console.log(JSON.stringify(frame));

  const type = z.object({ type: z.string() }).parse(frame).type;
  if (type === 'connection.ready') {
    socket.send(JSON.stringify({ type: 'chat.join', requestId: randomUUID(), eventId }));
  }
  if (type === 'chat.joined') {
    clientMessageId = randomUUID();
    socket.send(
      JSON.stringify({
        type: 'chat.message.send',
        requestId: randomUUID(),
        eventId,
        clientMessageId,
        body: process.env['CHAT_MESSAGE'] ?? 'Phase 6 WebSocket smoke test',
      }),
    );
  }
  if (type === 'chat.message.created') {
    const created = z
      .object({
        data: z.object({ message: z.object({ id: z.uuid(), body: z.string().nullable() }) }),
      })
      .parse(frame);
    console.log(`Persisted message ${created.data.message.id}`);
    socket.close(1000, 'smoke_complete');
  }
});

socket.on('unexpected-response', async (_request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  throw new Error(
    `Upgrade rejected: ${String(response.statusCode)} ${Buffer.concat(chunks).toString('utf8')}`,
  );
});

socket.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

socket.on('close', (code, reason) => {
  clearTimeout(timeout);
  console.log(`closed code=${String(code)} reason=${reason.toString()}`);
});
```

The repository already has `tsx`, so no new dependency or package script is
required. Start the development stack, sign in, and run:

```powershell
$env:ACCESS_TOKEN = 'YOUR_ACCESS_TOKEN'
$env:EVENT_ID = 'YOUR_EVENT_UUID'
yarn tsx scripts/chat-smoke-client.ts
```

Open two terminals with tokens for different active members and the same event.
Both should receive one `chat.message.created`. Then perform these drills:

1. Repeat a send frame with the same `clientMessageId` and body. The second
   acknowledgement has `duplicate: true`; no second broadcast or row appears.
2. Reuse that ID with a different body. Receive
   `CHAT_CLIENT_MESSAGE_ID_REUSED`.
3. Set typing true and stop. Observe automatic false within the configured
   typing TTL.
4. Delete your own message. Both clients receive the same tombstone and REST
   history returns `body: null`.
5. As a regular member, attempt to delete another member's message. Receive
   `CHAT_MODERATION_DENIED`. Repeat as an organizer and observe one audit row.
6. Leave one of two connections for the same user. Presence remains online.
   Leave both; presence becomes offline.
7. Suspend a membership while connected. The next meaningful delivery or
   heartbeat closes that connection with `4003`.
8. Stop Redis after clients are connected. Same-instance committed messages
   still broadcast locally; ticket creation and cross-instance ephemeral state
   degrade. Restart Redis and recover durable history through REST.
9. Stop the application. Observe close code `1001` before the process exits.

Inspect durable truth:

```powershell
docker compose exec postgres psql -U gatherly -d gatherly -c `
  "SELECT id, sender_user_id, client_message_id, body, deleted_at FROM chat_messages ORDER BY created_at DESC LIMIT 10;"

docker compose exec postgres psql -U gatherly -d gatherly -c `
  "SELECT message_id, actor_user_id, action, created_at FROM chat_moderation_actions ORDER BY created_at DESC LIMIT 10;"
```

Delete the PowerShell variables after the session if the terminal is shared:

```powershell
Remove-Item Env:ACCESS_TOKEN
Remove-Item Env:EVENT_ID
```

### Expected result

The ticket is consumed once, only the base subprotocol is negotiated, sends
commit before broadcast, retries are idempotent, typing expires, presence is
leased, moderation is authorized and audited, revocation takes effect, REST
recovers durable history, and shutdown closes the upgraded sockets.

---

## Checkpoint 12: Hand automated test implementation to AI

### Why this step is separate

The learner should implement and manually inspect WebSocket upgrade and frame
behavior before tests encode it. At this checkpoint, ask an AI coding agent to
add tests. The AI must not replace PostgreSQL with an in-memory message store,
make Redis authoritative, weaken Origin/ticket checks, remove authorization
locks, or change production behavior merely to simplify a test.

No automated test code is supplied here on purpose. All production files and
the smoke client above are complete; this checkpoint follows the same
learner-first testing boundary as the SSE handbook.

### Instructions for the AI coding agent

Give the AI this task:

> Read `AGENTS.md`, `README.md`,
> `PHASE_6_POSTGRES_PERFORMANCE_REDIS_HANDBOOK.md`,
> `PHASE_6_SSE_HANDBOOK.md`, and
> `PHASE_6_WEBSOCKETS_HANDBOOK.md`. Inspect the implemented source, migrations,
> and existing test helpers. Implement the smallest behavioral test suite that
> proves the WebSocket/chat contract below. Do not add product features or
> weaken persistence-before-broadcast, idempotency, authorization, ticket
> consumption, Origin validation, heartbeat, presence expiry, backpressure, or
> shutdown. Use Yarn Classic, preserve unrelated changes, run the proportional
> gate, and report exact commands and results.

The AI should extend `tests/helpers/test-app.ts` with optional chat HTTP
composition and create a reusable real HTTP/WebSocket harness. It should use
the `ws` client for wire tests, a real PostgreSQL Testcontainer for durable
claims, and a real Redis Testcontainer for ticket/Pub/Sub/presence claims.
Fakes remain appropriate for pure gateway scheduling and backpressure tests.

### Required behavioral coverage

The AI must cover all of these behaviors:

1. Ticket creation rejects absent, malformed, forged, expired, and inactive
   bearer tokens.
2. Redis-unavailable ticket creation returns safe
   `CHAT_HANDSHAKE_UNAVAILABLE` without affecting REST history.
3. Tickets are random, expire, are stored by digest, and are consumed exactly
   once under concurrent upgrade attempts.
4. Wrong path, missing/wrong Origin, missing base protocol, malformed ticket,
   expired ticket, and reused ticket never upgrade.
5. A valid upgrade selects only `gatherly.chat.v1`, sends
   `connection.ready`, and never echoes or logs the ticket.
6. Binary and oversized frames close with the documented codes. Malformed JSON,
   unknown types/properties, invalid UUIDs, and oversized bodies receive safe
   errors without invoking persistence.
7. Commands from one socket execute in arrival order. A message cannot be sent
   before joining the exact event.
8. History and join require current active account, community, membership, and
   supported event status. Cross-community/event/message ID substitution is
   denied.
9. A message row commits before local or Redis publication. An injected
   transaction failure produces no row and no broadcast.
10. Repeating the same `clientMessageId` and body returns the same message and
    no duplicate broadcast. Reusing it with a different body is rejected.
11. Two concurrent identical sends create one row. Two different sends both
    persist and history ordering remains deterministic.
12. History keyset pagination has no duplicates or gaps across equal
    timestamps, enforces the maximum limit, rejects malformed cursors, and
    emits tombstones without deleted bodies.
13. Authors may delete their own messages. Current active moderators,
    organizers, and owners may delete another user's message. Ordinary,
    suspended, banned, cross-community, and stale-role users may not.
14. Concurrent deletion creates one state transition and one moderation audit
    row; repeated deletion is idempotent.
15. Revocation racing with send/delete has a serial order enforced by database
    locks. Revocation during a connection blocks later commands/delivery and
    closes by the next heartbeat.
16. A real Redis Pub/Sub test sends a durable signal between two independently
    constructed application instances. The receiving instance reloads the
    canonical PostgreSQL message rather than trusting Redis content.
17. Redis publication failure after commit does not roll back or lose the
    message; REST history recovers it. Same-instance local delivery still
    occurs.
18. Typing true auto-expires, false cancels the timer, leave/disconnect clears
    it, and typing creates no PostgreSQL row.
19. Presence represents multiple connections independently, renews leases,
    remains online while one tab remains, and drops a crashed connection after
    lease expiry. Redis flush loses only ephemeral presence.
20. Ping/pong keeps responsive clients alive and terminates an unresponsive
    client. Maximum connection age sends `connection.refresh` and closes with
    `4001`.
21. Command flooding closes with `1008`. Excessive `bufferedAmount` closes
    with `1013` without an unbounded application queue.
22. Repeated shutdown calls are idempotent. Shutdown rejects new upgrades,
    closes WebSockets before HTTP drain, terminates a client which ignores the
    close handshake, clears timers, and closes each Redis/PostgreSQL dependency
    once.
23. Existing SSE, reservation concurrency, idempotency, authorization, Redis
    degradation, and graceful-shutdown tests continue to pass.

### Suggested test placement

```text
tests/unit/chat.schemas.test.ts
  command union, strict fields, body limits, cursor round-trip

tests/unit/chat.gateway.test.ts
  ordering, one-room rule, typing timers, quota, backpressure, ping/pong,
  maximum age, cleanup, idempotent shutdown

tests/api/chat.api.test.ts
  authenticated ticket endpoint, history validation and safe errors

tests/integration/chat-postgres.integration.test.ts
  access, history keysets, idempotent/concurrent send, rollback, deletion,
  audit rows, object substitution, revocation races

tests/integration/chat-redis.integration.test.ts
  ticket GETDEL race/expiry, two-instance Pub/Sub, publication outage,
  presence leases and multi-connection semantics

tests/integration/chat-websocket.integration.test.ts
  real HTTP upgrade, Origin/subprotocol/ticket checks, text/binary/oversize
  frames, live fan-out, close codes

tests/integration/graceful-shutdown.test.ts
  extend existing HTTP/SSE coverage with upgraded socket closure ordering
```

Every server, WebSocket, timer, Redis subscriber/publisher, Prisma client, and
PostgreSQL pool must close in `afterEach` or `afterAll`, including failed
handshakes. Tests must not rely on arbitrary sleeps when an event/promise can
prove completion.

### AI acceptance gate

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn vitest run tests/unit/chat.schemas.test.ts
yarn vitest run tests/unit/chat.gateway.test.ts
yarn vitest run tests/api/chat.api.test.ts
yarn vitest run tests/integration/chat-postgres.integration.test.ts
yarn vitest run tests/integration/chat-redis.integration.test.ts
yarn vitest run tests/integration/chat-websocket.integration.test.ts
yarn vitest run tests/integration/graceful-shutdown.test.ts
yarn test
yarn build
```

If filenames differ, the AI must report actual commands. It must also state
which tests use fakes, real sockets, PostgreSQL Testcontainers, or Redis
Testcontainers and why.

### Expected result

The suite proves protocol, persistence, authorization, distributed fan-out,
ephemeral state, and lifecycle behavior at the smallest useful levels without
moving design decisions into the test step.

---

## Failure drills

### Redis absent at startup

Expected:

- the process and PostgreSQL-backed HTTP endpoints start;
- liveness/readiness remain healthy when PostgreSQL is healthy;
- ticket creation returns safe `503`;
- already-authenticated sockets on the same instance can persist messages and
  receive local broadcasts;
- distributed fan-out, typing, and presence degrade without becoming truth.

### Redis stops after sockets connect

Expected:

- message transactions still commit;
- the sender receives an acknowledgement and same-instance clients receive
  local delivery;
- clients on another instance may miss the live signal;
- REST history recovers every committed message and tombstone;
- Redis recovery permits new tickets and later ephemeral updates.

### PostgreSQL becomes unavailable

Expected:

- readiness becomes `503`;
- history and durable commands fail without partial state;
- the gateway sends no invented durable message;
- unexpected database failures close the affected command connection safely;
- Redis content cannot be promoted to business truth.

### Permission changes while connected

Suspend or ban the membership, archive the community, suspend the account, or
demote a moderator. Later sends/deletes are denied. A later delivery or
heartbeat removes the room and closes with `4003`. Previously committed
messages remain canonical history for users who still have access.

### Duplicate and ambiguous sends

Disconnect after sending but before receiving acknowledgement. Reconnect,
reload history, and retry with the original `clientMessageId` and body. The
same server message returns and no second row/broadcast appears. A changed body
with that ID is a conflict, never an edit.

### Slow or flooded client

When outbound buffering exceeds the bound, close with `1013`; when inbound
commands exceed the window, close with `1008`. Do not buffer more frames in an
array. Durable state is recovered through history.

### Half-open connection

Prevent a client from replying to protocol ping. One interval marks it dead;
the next interval terminates it. Its presence lease expires even if close
cleanup never reaches Redis.

### Application shutdown

Expected order:

```text
readiness false
-> stop accepting new WebSocket and SSE connections
-> close WebSockets and SSE streams
-> terminate WebSockets which ignore close
-> drain ordinary HTTP requests
-> unsubscribe/close chat and SSE Redis subscribers
-> close ordinary Redis, Prisma, and pg clients
```

The exact order of WebSocket and SSE closure inside the long-lived hook may be
parallel, but both must finish before ordinary HTTP drain waits.

## Common mistakes

- Broadcasting a message before its PostgreSQL transaction commits.
- Storing chat only in Redis, memory, Pub/Sub, or the WebSocket connection.
- Treating Pub/Sub as replayable or exactly once.
- Sending the JWT in the WebSocket URL.
- Returning the one-use ticket as the selected subprotocol.
- Storing raw tickets in Redis or logs instead of digesting them.
- Forgetting that CORS middleware does not validate an upgrade Origin.
- Authenticating only at connection time and never reauthorizing room actions.
- Trusting a client-supplied community, sender, username, role, or timestamp.
- Broadcasting to every authenticated socket and relying on clients to filter.
- Allowing a message ID from one event to be deleted through another event ID.
- Using a random UUID alone as a chronological pagination cursor.
- Replaying a send with a new `clientMessageId` after an ambiguous disconnect.
- Treating a reused client ID with changed body as an edit.
- Hard-deleting moderation evidence or broadcasting deletion without a DB row.
- Persisting typing or presence as permanent domain state.
- Modeling presence only by user ID, so one closing tab makes all tabs offline.
- Publishing message bodies through Redis when an identifier can reload truth.
- Accepting binary frames or the `ws` default maximum payload unintentionally.
- Enabling compression without measuring a need and memory cost.
- Ignoring `bufferedAmount` or building an unbounded send queue.
- Implementing heartbeat as JSON rather than protocol ping/pong.
- Starting one interval or Redis subscriber per socket.
- Assuming `server.closeAllConnections()` closes upgraded WebSockets.
- Retrying abnormal disconnects immediately without backoff and jitter.
- Logging private message bodies, tickets, JWTs, subprotocol headers, or cookies.
- Adding direct messages, uploads, reports, Kafka, or Elasticsearch in this increment.

## Suggested commit sequence

1. `docs: add phase 6 websocket handbook`
2. `feat: add persisted event chat schema and history`
3. `feat: add idempotent chat send and moderation deletion`
4. `feat: add one-use websocket tickets and authenticated upgrade`
5. `feat: add websocket gateway heartbeat and command limits`
6. `feat: add redis chat fanout typing and presence`
7. `docs: document websocket protocol and recovery`
8. `test: prove websocket persistence authorization and lifecycle` (AI checkpoint)

Do not combine Elasticsearch, Kafka, Nginx, attachments, or direct messages
with these commits.

## Final examination

The WebSocket increment is complete when you can answer these without
guessing:

1. Why is WebSocket justified here while SSE remains preferable for personal
   notifications and organizer counters?
2. Which tables own a message and its deletion audit?
3. What proves a message was committed before broadcast?
4. What happens if commit succeeds and Redis publication fails?
5. Why does reconnect use REST history rather than WebSocket replay?
6. How does `clientMessageId` handle an ambiguous disconnect?
7. Why must reuse with a changed body be rejected?
8. How does the history cursor order equal timestamps deterministically?
9. How does target-object authorization prevent cross-event deletion?
10. What lock ordering makes membership revocation and send have a clear
    serialization point?
11. Why can upgrade authentication not authorize the socket forever?
12. Why is a one-use ticket used instead of a JWT query parameter?
13. Why is the ticket hashed in Redis and consumed with one atomic operation?
14. Why must Origin be checked separately from Express CORS?
15. What information may a durable Redis signal contain, and what must the
    receiver do with it?
16. Why are typing and presence allowed to disappear?
17. How do multiple connections for one user affect presence?
18. How does a crashed process's presence eventually disappear?
19. What do protocol ping/pong prove, and what do they not prove?
20. What happens when `bufferedAmount` exceeds the bound?
21. Which close codes are standard and which are Gatherly application codes?
22. Why does maximum connection age still matter when heartbeats work?
23. Why does `server.closeAllConnections()` not finish WebSocket shutdown?
24. Which behaviors require real HTTP sockets, PostgreSQL, or Redis tests?
25. Why is this still one modular monolith rather than a chat microservice?

## Completion commands

After the AI testing checkpoint is complete, run:

```powershell
yarn prisma:generate
yarn prisma:validate
yarn typecheck
yarn lint
yarn test
yarn build
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
```

The deliverable is one bounded event-chat vertical slice. PostgreSQL owns
messages and moderation, Redis owns only disposable coordination and tickets,
SSE keeps its one-way jobs, and WebSockets are used only where the client must
send low-latency commands in both directions.

## Official references

- IETF, [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455)
- WHATWG, [The WebSocket API](https://websockets.spec.whatwg.org/)
- Node.js, [`http` upgrade and server shutdown](https://nodejs.org/api/http.html)
- `ws`, [README and usage examples](https://github.com/websockets/ws)
- `ws`, [API documentation](https://github.com/websockets/ws/blob/master/doc/ws.md)
- PostgreSQL 17, [Explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- PostgreSQL 17, [Transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- Redis, [`GETDEL`](https://redis.io/docs/latest/commands/getdel/)
- Redis, [`ZADD`](https://redis.io/docs/latest/commands/zadd/)
- Redis, [Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- OWASP, [WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
